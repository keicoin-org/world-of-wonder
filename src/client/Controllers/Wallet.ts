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
import { Kei } from "kei-transaction";

import { apiUrl, nodeUrl } from "../Utils/index";

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
        catalogue.items.forEach((item) => this._shop.set(item.key, item));
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
