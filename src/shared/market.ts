import type { Offer } from "kei-transaction";

/**
 * The parts of a hall row that must still describe the offer read from the
 * chain when a buyer clicks it.
 *
 * A hall is only an index and is not trusted. In particular, matching the
 * price and quantity is insufficient: a dishonest hall could attach the hash
 * of a different item at the same price and make the wallet accept that asset.
 */
export interface DisplayedOffer {
    hash: string;
    seller: string;
    qty: number;
    price: number;
}

/** True only when the chain offer is exactly the trade shown to the buyer. */
export function offerMatchesDisplay(
    offer: Offer,
    displayed: DisplayedOffer,
    itemAsset: string,
    coinAsset: string
): boolean {
    return (
        offer.hash === displayed.hash &&
        offer.from === displayed.seller &&
        offer.give.asset === itemAsset &&
        offer.give.amount === displayed.qty &&
        offer.want.asset === coinAsset &&
        offer.want.amount === displayed.price
    );
}

/**
 * A lot on the auction block: how many units, what one of them is asked for, and
 * what the whole thing therefore costs.
 *
 * This type exists because one number meant both things in two adjacent controls
 * (issue #14). The auction's Ask box was seeded with an item's per-unit shop
 * price and then signed straight onto the `want` leg, which is the lot total — so
 * stepping the quantity to ten and accepting the number the panel had put there
 * published a lot of ten at a tenth of the price shown. The ledger settles what
 * the leg says and has no notion of a unit price, so nothing catches it after.
 *
 * Hence: no field here is called `price`. That name is what let the two be
 * confused, and it is the one word that does not say which of them it means.
 */
export interface Lot {
    /** Units on the block. The `give` leg's amount. */
    qty: number;
    /** Gold for one of them — what a seller types and what a row calls "each". */
    each: number;
    /** `each × qty`: the `want` leg's amount, and what a buyer hands over. */
    total: number;
}

/**
 * Price a lot from a per-unit ask. The only multiplication of the two in this
 * repository, so there is one place for it to be right.
 *
 * The multiply happens in `BigInt` and is checked back into `number` afterwards,
 * because `number` is what the SDK's `OfferOptions.amount` takes and is therefore
 * where precision can be lost. Gold is `decimals: 0`, so every honest total is a
 * whole number; one that cannot be represented as an exact whole number is a
 * listing that would settle for a different amount than it displayed, which is
 * the whole family of bug this function exists to close.
 *
 * The refusals are sentences because a player reads them.
 */
export function priceLot(each: number, qty: number): Lot {
    if (!Number.isInteger(each) || each < 1) {
        throw new Error("Ask a whole number of gold for one of them, and at least 1.");
    }
    if (!Number.isInteger(qty) || qty < 1) {
        throw new Error("List a whole number of them, and at least 1.");
    }
    const total = BigInt(each) * BigInt(qty);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${each} gold each for ${qty} of them is more gold than this world can count.`);
    }
    return { qty, each, total: Number(total) };
}

/**
 * The two legs of an auction listing: the items on one side, the whole lot's gold
 * on the other.
 *
 * A `swap_offer` carries one amount per leg and nothing that says "per unit", so
 * this is the last point at which the distinction still exists and the only place
 * it is allowed to be resolved. Anything that lists goes through here.
 */
export function lotOffer(
    itemAsset: string,
    coinAsset: string,
    lot: Lot
): { give: { asset: string; amount: number }; want: { asset: string; amount: number } } {
    return {
        give: { asset: itemAsset, amount: lot.qty },
        want: { asset: coinAsset, amount: lot.total },
    };
}
