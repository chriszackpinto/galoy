import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"
import Memo from "@graphql/types/scalar/memo"
import WalletId from "@graphql/types/scalar/wallet-id"
import CentAmount from "@graphql/types/scalar/cent-amount"
import LnInvoicePayload from "@graphql/types/payload/ln-invoice"
import { Wallets } from "@app"
import { WalletsRepository } from "@services/mongoose"
import { WalletCurrency } from "@domain/shared"
import dedent from "dedent"

const LnUsdInvoiceCreateInput = GT.Input({
  name: "LnUsdInvoiceCreateInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "Wallet ID for a USD wallet belonging to the current user.",
    },
    amount: { type: GT.NonNull(CentAmount), description: "Amount in USD cents." },
    memo: { type: Memo, description: "Optional memo for the lightning invoice." },
  }),
})

const LnUsdInvoiceCreateMutation = GT.Field({
  type: GT.NonNull(LnInvoicePayload),
  description: dedent`Returns a lightning invoice denominated in satoshis for an associated wallet.
  When invoice is paid the equivalent value at invoice creation will be credited to a USD wallet.
  Expires after 2 minutes (short expiry time because there is a USD/BTC exchange rate
  associated with the amount).`,
  args: {
    input: { type: GT.NonNull(LnUsdInvoiceCreateInput) },
  },
  resolve: async (_, args) => {
    const { walletId, memo, amount } = args.input

    for (const input of [walletId, memo, amount]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof Error)
      return { errors: [{ message: mapError(wallet).message }] }

    const MutationDoesNotMatchWalletCurrencyError =
      "MutationDoesNotMatchWalletCurrencyError"
    if (wallet.currency === WalletCurrency.Btc) {
      return { errors: [{ message: MutationDoesNotMatchWalletCurrencyError }] }
    }

    const lnInvoice = await Wallets.addInvoiceForSelf({
      walletId,
      amount,
      memo,
    })

    if (lnInvoice instanceof Error) {
      const appErr = mapError(lnInvoice)
      return { errors: [{ message: appErr.message }] }
    }

    return {
      errors: [],
      invoice: lnInvoice,
    }
  },
})

export default LnUsdInvoiceCreateMutation
