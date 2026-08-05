/**
 * The player's half of the economy: one key, held in this browser, and the only
 * thing in this game that can spend their gold.
 *
 * The server issues the currency and delivers what was paid for, but it cannot
 * sign for this account (SPEC §6.3). So nothing here asks the server to move
 * money — paying is a transfer this file signs, and a balance is a question put
 * to the node rather than a number the server sent us. What the server is asked
 * for is only what the chain does not know: what things cost, and that a
 * purchase was intended.
 *
 * `Kei.start()` generates the seed on first run and keeps it in localStorage, so
 * a player who comes back is the same player. Clearing site data loses the
 * wallet, which is the other half of owning it.
 */

import axios from "axios";
import { Kei, type Offer } from "kei-transaction";

import { apiUrl, nodeUrl } from "../Utils/index";
import { lotOffer, offerMatchesDisplay, priceLot } from "../../shared/market";

export interface ShopItem {
    key: string;
    title: string;
    /** What the shop charges for one. */
    value: number;
    /** What the shop pays for one, or 0 when it will not buy it at all. */
    buyback: number;
    asset: string;
    sellable: boolean;
}

/** One auction-house listing: a `swap_offer` block on somebody's own chain. */
export interface Listing {
    /** The offer block's hash, which is its id (SPEC §9.3). */
    hash: string;
    seller: string;
    key: string;
    title: string;
    qty: number;
    /** Total gold asked for the lot. */
    price: number;
    /** Gold per unit. */
    each: number;
    /** Written by this wallet, so it can be cancelled and cannot be accepted. */
    mine: boolean;
}

/** What an archetype has sold for in the hall, read off settled swaps. */
export interface Sold {
    key: string;
    last: number;
    median: number;
    low: number;
    high: number;
    trades: number;
}

export interface HallView {
    /** How many chains the server walked. Zero means nobody has been seen yet. */
    accounts: number;
    listings: Listing[];
    history: { [key: string]: Sold };
}

interface Catalogue {
    issuer: string;
    network: "mock" | "testnet" | "mainnet";
    coin: { asset: string; symbol: string; decimals: number };
    exchange: { open: boolean; goldPerKei: number; minimum: number };
    items: ShopItem[];
}

/** How long to wait on the chain before telling the player it has not happened. */
const SETTLE_TIMEOUT_MS = 20_000;
const POLL_MS = 400;

export class Wallet {
    private readonly _kei;
    private readonly _base: string;
    private readonly _shop: Map<string, ShopItem> = new Map();
    /** The same wares, keyed the way an offer names them. */
    private readonly _byAsset: Map<string, ShopItem> = new Map();
    private readonly _coin: string;
    private readonly _coinScale: number;

    public readonly address: string;
    /** Where purchases are paid, and where a sale is sent. */
    public readonly shopkeeper: string;

    /** What the chain last said. `refresh()` is what makes these true again. */
    public gold: number = 0;
    public inventory: { [key: string]: number } = {};

    private constructor(kei, base: string, catalogue: Catalogue) {
        this._kei = kei;
        this._base = base;
        this._coin = catalogue.coin.asset;
        this._coinScale = 10 ** catalogue.coin.decimals;
        this.address = kei.address;
        this.shopkeeper = catalogue.issuer;
        catalogue.items.forEach((item) => {
            this._shop.set(item.key, item);
            this._byAsset.set(item.asset, item);
        });
    }

    /**
     * Opening a wallet asks the server two things — what this world sells, and
     * which chain it is on — and neither of them is a secret. Everything after
     * this point is between the player and the node.
     */
    static async open(port): Promise<Wallet> {
        const base = apiUrl(port);
        const catalogue: Catalogue = (await axios.get(base + "/kei/catalogue")).data;
        const kei = await Kei.start({ node: nodeUrl(port), network: catalogue.network });
        const wallet = new Wallet(kei, base, catalogue);
        // The auction house cannot find this player's listings unless somebody
        // tells it there is a chain here to read (SPEC §9.4 — no indexer). Doing
        // it on open is what makes the hall's roster survive a server restart.
        void wallet.announce();
        await wallet.refresh();
        return wallet;
    }

    /** What this world sells, whether or not the vendor in front of you stocks it. */
    public wares(): ShopItem[] {
        return Array.from(this._shop.values());
    }

    public priced(key: string): ShopItem | undefined {
        return this._shop.get(key);
    }

    /** What the player holds that this shop would buy back. */
    public sellable(): Array<{ item: ShopItem; qty: number }> {
        const held: Array<{ item: ShopItem; qty: number }> = [];
        this._shop.forEach((item, key) => {
            const qty = this.inventory[key] ?? 0;
            if (qty > 0 && item.sellable) held.push({ item, qty });
        });
        return held;
    }

    /** Ask the chain what we hold, and sign for anything waiting on us. */
    public async refresh(): Promise<void> {
        // A delivery arrives as a block addressed to us, and is not ours until we
        // sign for it. The background collector does this anyway; doing it here
        // means a player watching the panel sees it happen now rather than soon.
        await this._kei.sync();

        const balances: Map<string, number> = new Map();
        const holdings = await this._kei.client.node.holdings(this.address);
        holdings.forEach((holding) => balances.set(holding.asset, Number(holding.balance)));

        this.gold = (balances.get(this._coin) ?? 0) / this._coinScale;

        // Items are whole things, so their balance is already a count. Only the
        // archetypes this world issued are ours to name; anything else the player
        // holds is theirs and none of the game's business.
        const inventory: { [key: string]: number } = {};
        this._shop.forEach((item, key) => {
            const qty = balances.get(item.asset) ?? 0;
            if (qty > 0) inventory[key] = qty;
        });
        this.inventory = inventory;
    }

    /**
     * Buying, which takes two signatures and neither of them is the server's.
     *
     * The order is recorded first because a transfer carries no memo, so that is
     * the only way an arriving pile of gold can be matched to what it was for.
     * Then we pay, which only the player can do. Delivery is the shop's answer to
     * the gold landing — so this waits for the item, not for a response.
     */
    public async buy(key: string, qty: number): Promise<void> {
        const item = this.mustKnow(key);

        await this.refresh();
        const before = this.inventory[key] ?? 0;

        const order = await this.ask("/kei/order", { address: this.address, key, qty });
        const gold = await this._kei.token.get(order.asset);
        await gold.transfer(order.to, order.price);

        const delivered = await this.until(async () => {
            await this.refresh();
            return (this.inventory[key] ?? 0) >= before + qty;
        });

        if (!delivered) {
            throw new Error(`Your gold was sent, but ${item.title} has not arrived yet. Check again in a moment.`);
        }
    }

    /**
     * Selling, which takes one signature, and it is the player's.
     *
     * There is nothing to ask permission for: the shop pays for whatever lands in
     * its account, so parting with the item is the entire transaction. That is
     * also why it costs the item first — a shop that paid on request would be
     * minting gold for anyone who asked.
     */
    public async sell(key: string, qty: number = 1): Promise<number> {
        const item = this.mustKnow(key);
        if (!item.sellable) {
            throw new Error(`${item.title} is not something this shop buys.`);
        }

        await this.refresh();
        if ((this.inventory[key] ?? 0) < qty) {
            throw new Error(`You do not have ${qty > 1 ? qty + " of those" : "one of those"} to sell.`);
        }
        const before = this.gold;

        // One at a time, which is what a shopkeeper's counter does anyway.
        for (let sold = 0; sold < qty; sold++) {
            await this._kei.items.transfer(item.asset, this.shopkeeper);
        }

        const paid = await this.until(async () => {
            await this.refresh();
            return this.gold >= before + item.buyback * qty;
        });

        if (!paid) {
            throw new Error(`The shop has your ${item.title} and has not paid yet. Check your purse in a moment.`);
        }
        return this.gold - before;
    }

    // --------------------------------------------------------- auction house

    /**
     * What is for sale, across the chains the hall knows to ask (SPEC §9.1).
     *
     * The server assembles this because it is the one holding the list of
     * addresses, and for no other reason — every number in it was read off the
     * chain and would be identical if this browser walked the same accounts
     * itself. Nothing here is taken on trust: `accept` re-reads the offer before
     * signing anything.
     */
    public async hall(): Promise<HallView> {
        const view = (await axios.get(this._base + "/kei/hall")).data;
        const listings: Listing[] = [];
        (view.listings ?? []).forEach((stall) => {
            // The hall is not trusted to name an asset. Use its catalogue key
            // only to find this client's copy of the title; an unknown key is
            // not something this world can safely offer to buy.
            const item = this._shop.get(stall.key);
            if (!item) return;
            listings.push({
                hash: stall.hash,
                seller: stall.seller,
                key: item.key,
                title: item.title,
                qty: stall.qty,
                price: stall.price,
                each: stall.each,
                mine: stall.seller === this.address,
            });
        });
        return { accounts: view.accounts ?? 0, listings, history: view.history ?? {} };
    }

    /** This wallet's own open listings, read straight off its own chain. */
    public async myListings(): Promise<Listing[]> {
        const offers = await this._kei.market.mine({ state: "open" });
        const listings: Listing[] = [];
        offers.forEach((offer) => {
            const listing = this.asListing(offer);
            if (listing) listings.push(listing);
        });
        return listings;
    }

    /**
     * List an item for gold, at `each` gold per unit.
     *
     * Per unit, and named so, because the offer's `want` leg is the lot total and
     * these are the same number only when `qty` is 1 (issue #14). `priceLot` does
     * the multiply, refuses a price that cannot be settled exactly, and is the
     * only thing in this repository that turns one into the other.
     *
     * `market.offer()`, not `market.sell()`: `sell()` prices in Kei, and this
     * world's money is gold — an asset it issues. The distinction compiles
     * either way, which is exactly why it is worth stating.
     *
     * Publishing locks the item on this player's own chain (SPEC §9.2), so it
     * leaves the bag the moment this returns and comes back only if the listing
     * is cancelled. Nobody else's asset is locked by any of this.
     */
    public async list(key: string, each: number, qty: number = 1): Promise<Listing> {
        const item = this.mustKnow(key);
        const lot = priceLot(each, qty);

        await this.refresh();
        const held = this.inventory[key] ?? 0;
        if (held < qty) {
            throw new Error(`You have ${held} ${item.title} to list, not ${qty}.`);
        }

        const offer = await this._kei.market.offer(lotOffer(item.asset, this._coin, lot));

        await this.announce();
        await this.refresh();

        const listing = this.asListing(offer);
        if (!listing) {
            // The offer is on the chain either way — it is this catalogue that
            // cannot describe it, which means the shop and the chain disagree
            // about what this world sells. Say that rather than returning
            // nothing and letting the panel find out.
            throw new Error(`${item.title} is listed, but this world's catalogue no longer recognises it. Reload the game.`);
        }
        return listing;
    }

    /**
     * Buy somebody else's listing. One block, both legs or neither (SPEC §9.2).
     *
     * The hall is an index rather than an authority, so the offer is read back
     * off the chain first and refused if it is not the one that was on screen.
     * The SDK signs the ledger's numbers and not this panel's, so without that
     * check a listing repriced between the read and the click would simply be
     * paid.
     */
    public async accept(listing: Listing): Promise<void> {
        if (listing.mine) {
            throw new Error("That is your own listing. Cancel it to take the item back.");
        }

        const live = await this._kei.market.get(listing.hash);
        if (!live || live.state !== "open") {
            throw new Error(`${listing.title} is gone — somebody else bought it, or the seller took it back.`);
        }
        const item = this._shop.get(listing.key);
        if (!item || !offerMatchesDisplay(live, listing, item.asset, this._coin)) {
            throw new Error(
                "That listing does not match the seller, item, quantity, and price that were shown to you. Refresh the hall and look again."
            );
        }

        await this._kei.market.accept(live);
        // Whoever we just traded with is worth reading, and so are we: both
        // chains can carry the next listing.
        await this.announce();
        await this.refresh();
    }

    /** Take a listing back. Only its author can, because only their asset is locked. */
    public async cancel(listing: Listing): Promise<void> {
        await this._kei.market.cancel(listing.hash);
        await this.refresh();
    }

    /** Tell the hall this chain is worth reading. Costs nothing and grants nothing. */
    public async announce(): Promise<void> {
        try {
            await axios.post(this._base + "/kei/hall/watch", null, { params: { address: this.address } });
        } catch (error) {
            // The hall is an index. Failing to appear in it costs visibility,
            // never an asset — the listing is on the chain either way.
        }
    }

    /** An offer in this world's terms, or nothing if it is not this world's business. */
    private asListing(offer: Offer): Listing | undefined {
        const item = this._byAsset.get(offer.give.asset);
        if (!item || offer.want.asset !== this._coin) return undefined;
        return {
            hash: offer.hash,
            seller: offer.from,
            key: item.key,
            title: item.title,
            qty: offer.give.amount,
            price: offer.want.amount,
            each: offer.price,
            mine: offer.from === this.address,
        };
    }

    public close(): void {
        this._kei.close();
    }

    private mustKnow(key: string): ShopItem {
        const item = this._shop.get(key);
        if (!item) {
            throw new Error(`This world does not deal in "${key}".`);
        }
        return item;
    }

    /** Ask the shop something, and let its refusal be the sentence the player reads. */
    private async ask(path: string, params): Promise<any> {
        try {
            return (await axios.post(this._base + path, null, { params })).data;
        } catch (error) {
            const refusal = error?.response?.data?.error;
            throw new Error(refusal ?? "The shop did not answer.");
        }
    }

    private async until(settled: () => Promise<boolean>): Promise<boolean> {
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (await settled()) return true;
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        return false;
    }
}
