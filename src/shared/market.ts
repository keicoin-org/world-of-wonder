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
