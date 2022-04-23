import { toSats } from "@domain/bitcoin"
import { defaultTimeToExpiryInSeconds, PaymentStatus } from "@domain/bitcoin/lightning"
import { InconsistentDataError } from "@domain/errors"
import { LedgerService } from "@services/ledger"
import { LndService } from "@services/lnd"
import { LockService } from "@services/lock"
import { runInParallel } from "@utils"

import { Wallets } from "@app"
import { WalletsRepository } from "@services/mongoose"

import { PaymentFlowStateRepository } from "@services/payment-flow"
import { inputAmountFromLedgerTransaction } from "@domain/ledger"

export const updatePendingPayments = async (logger: Logger): Promise<void> => {
  const ledgerService = LedgerService()
  const walletIdsWithPendingPayments = ledgerService.listWalletIdsWithPendingPayments()

  if (walletIdsWithPendingPayments instanceof Error) {
    logger.error(
      { error: walletIdsWithPendingPayments },
      "finish updating pending payments with error",
    )
    return
  }

  await runInParallel({
    iterator: walletIdsWithPendingPayments,
    logger,
    processor: async (walletId: WalletId, index: number) => {
      logger.trace(
        "updating pending payments for walletId %s in worker %d",
        walletId,
        index,
      )
      await updatePendingPaymentsByWalletId({ walletId, logger })
    },
  })

  logger.info("finish updating pending payments")
}

export const updatePendingPaymentsByWalletId = async ({
  walletId,
  logger,
  lock,
}: {
  walletId: WalletId
  logger: Logger
  lock?: DistributedLock
}): Promise<void | ApplicationError> => {
  const ledgerService = LedgerService()
  const count = await ledgerService.getPendingPaymentsCount(walletId)
  if (count instanceof Error) return count
  if (count === 0) return

  const pendingPayments = await ledgerService.listPendingPayments(walletId)
  if (pendingPayments instanceof Error) return pendingPayments

  for (const pendingPayment of pendingPayments) {
    await updatePendingPayment({
      walletId,
      pendingPayment,
      logger,
      lock,
    })
  }
}

const updatePendingPayment = async ({
  walletId,
  pendingPayment,
  logger,
  lock,
}: {
  walletId: WalletId
  pendingPayment: LedgerTransaction<WalletCurrency>
  logger: Logger
  lock?: DistributedLock
}): Promise<true | ApplicationError> => {
  const paymentLogger = logger.child({
    topic: "payment",
    protocol: "lightning",
    transactionType: "payment",
    onUs: false,
    payment: pendingPayment,
  })

  const lndService = LndService()
  if (lndService instanceof Error) return lndService

  const { paymentHash, pubkey } = pendingPayment
  // If we had PaymentLedgerType => no need for checking the fields
  if (!paymentHash)
    throw new InconsistentDataError("paymentHash missing from payment transaction")
  if (!pubkey) throw new InconsistentDataError("pubkey missing from payment transaction")

  const lnPaymentLookup = await lndService.lookupPayment({
    pubkey,
    paymentHash,
  })
  if (lnPaymentLookup instanceof Error) {
    const lightningLogger = logger.child({
      topic: "payment",
      protocol: "lightning",
      transactionType: "payment",
      onUs: false,
    })
    lightningLogger.error({ err: lnPaymentLookup }, "issue fetching payment")
    return lnPaymentLookup
  }

  let roundedUpFee: Satoshis
  const { status } = lnPaymentLookup
  if (status != PaymentStatus.Failed) {
    roundedUpFee = lnPaymentLookup.confirmedDetails?.roundedUpFee || toSats(0)
  }

  if (status === PaymentStatus.Settled || status === PaymentStatus.Failed) {
    const ledgerService = LedgerService()
    return LockService().lockPaymentHash({ paymentHash, logger, lock }, async () => {
      const recorded = await ledgerService.isLnTxRecorded(paymentHash)
      if (recorded instanceof Error) {
        paymentLogger.error({ error: recorded }, "we couldn't query pending transaction")
        return recorded
      }

      if (recorded) {
        paymentLogger.info("payment has already been processed")
        return true
      }

      const settled = await ledgerService.settlePendingLnPayment(paymentHash)
      if (settled instanceof Error) {
        paymentLogger.error({ error: settled }, "no transaction to update")
        return settled
      }

      const wallet = await WalletsRepository().findById(walletId)
      if (wallet instanceof Error) return wallet

      if (status === PaymentStatus.Settled) {
        paymentLogger.info(
          { success: true, id: paymentHash, payment: pendingPayment },
          "payment has been confirmed",
        )

        const revealedPreImage = lnPaymentLookup.confirmedDetails?.revealedPreImage
        if (revealedPreImage)
          LedgerService().updateMetadataByHash({
            hash: paymentHash,
            revealedPreImage,
          })
        if (pendingPayment.feeKnownInAdvance) return true

        const paymentFlow = await PaymentFlowStateRepository(
          defaultTimeToExpiryInSeconds,
        ).findLightningPaymentFlow({
          walletId,
          paymentHash,
          inputAmount: BigInt(inputAmountFromLedgerTransaction(pendingPayment)),
        })
        if (paymentFlow instanceof Error) return paymentFlow

        return Wallets.reimburseFee({
          paymentFlow,
          journalId: pendingPayment.journalId,
          actualFee: roundedUpFee,
          revealedPreImage,
          paymentAmount: toSats(
            (pendingPayment.debit > 0 ? pendingPayment.debit : pendingPayment.credit) -
              pendingPayment.fee,
          ),
          usdFee: pendingPayment.feeUsd as DisplayCurrencyBaseAmount,
          logger,
        })
      } else if (status === PaymentStatus.Failed) {
        paymentLogger.warn(
          { success: false, id: paymentHash, payment: pendingPayment },
          "payment has failed. reverting transaction",
        )

        const voided = await ledgerService.revertLightningPayment({
          journalId: pendingPayment.journalId,
          paymentHash,
        })
        if (voided instanceof Error) {
          const error = `error voiding payment entry`
          logger.fatal({ success: false, result: lnPaymentLookup }, error)
          return voided
        }
      }
      return true
    })
  }
  return true
}
