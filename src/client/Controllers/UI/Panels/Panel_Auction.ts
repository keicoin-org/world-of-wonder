/**
 * The auction house, as a player sees it.
 *
 * This is the screen SPEC §13 asks of M7, and the whole of what it does is read
 * a list and sign blocks. Nothing on it goes through the game server: a listing
 * is a `swap_offer` block on the seller's own chain, buying one is a single
 * `swap_accept` that moves the item and the gold together or moves neither, and
 * cancelling is the seller taking their own lock back (SPEC §9.2). The server's
 * only part is remembering which chains to read, because an offer lives with its
 * author and Kei ships no indexer (§9.4).
 *
 * Two things about that are visible in this file rather than hidden by it.
 *
 * **The hall is not the market.** It shows the listings of players this server
 * has seen, which is not the same as every listing on the network and cannot be
 * made the same without an indexer. The panel says so instead of presenting its
 * handful of offers as the whole book.
 *
 * **Listing costs you the item first.** The offer locks it on your own chain, so
 * it leaves the bag when you list and comes back when you cancel. That is the
 * same property that makes the trade safe — the sword cannot be sold twice, and
 * the ledger is what refuses the second attempt, not this panel.
 */

import { Control } from "@babylonjs/gui/2D/controls/control";
import { Button } from "@babylonjs/gui/2D/controls/button";
import { InputText } from "@babylonjs/gui/2D/controls/inputText";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { ScrollViewer } from "@babylonjs/gui/2D/controls/scrollViewers/scrollViewer";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { TextBlock, TextWrapping } from "@babylonjs/gui/2D/controls/textBlock";

import { Panel } from "./Panel";
import type { HallView, Listing, Sold } from "../../Wallet";

type Tab = "browse" | "sell" | "mine";

/** One line in whichever list is showing. */
interface Row {
    /** Unique within the list, and what selection is remembered by. */
    id: string;
    key: string;
    title: string;
    /** Right-hand column: an asking price, or what the shop would pay. */
    note: string;
    listing?: Listing;
    /** How many the chain says the player holds, on the selling side. */
    held?: number;
}

const BACKGROUND = "#292929";
const SELECTED = "green";

export class Panel_Auction extends Panel {
    private tabs: Rectangle;
    private stackPanel: StackPanel;
    private panelDetails: Rectangle;
    private purseText: TextBlock;
    private statusText: TextBlock;

    private tab: Tab = "browse";
    private selected: string = "";
    /** Set while something is being signed, so nothing is signed twice. */
    private busy: boolean = false;

    private view: HallView = { accounts: 0, listings: [], history: {} };
    private listed: Listing[] = [];

    constructor(_UI, _currentPlayer, options) {
        super(_UI, _currentPlayer, options);
        this.createContent();
    }

    private get wallet() {
        return this._game.wallet;
    }

    public open() {
        super.open();
        if (this.isOpen()) void this.reload();
    }

    // ----------------------------------------------------------------- frame

    private createContent() {
        const content: Rectangle = this._panelContent;
        content.getDescendants().forEach((el) => el.dispose());

        const tabs = new Rectangle("auctionTabs");
        tabs.width = 1;
        tabs.height = "26px";
        tabs.top = "0px";
        tabs.thickness = 0;
        tabs.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        tabs.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        content.addControl(tabs);
        this.tabs = tabs;

        this.addTab("browseTab", "Browse", "5px", "browse");
        this.addTab("sellTab", "Sell", "75px", "sell");
        this.addTab("mineTab", "Mine", "145px", "mine");

        const refresh = Button.CreateSimpleButton("auctionRefresh", "Refresh");
        refresh.width = "70px";
        refresh.height = "24px";
        refresh.left = "-5px";
        refresh.background = "black";
        refresh.color = "white";
        refresh.thickness = 0;
        refresh.fontSize = "13px";
        refresh.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        refresh.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        tabs.addControl(refresh);
        refresh.onPointerClickObservable.add(() => {
            if (this.busy) return;
            void this.reload();
        });

        const purse = new TextBlock("auctionPurse");
        purse.text = "";
        purse.color = "orange";
        purse.fontSize = "13px";
        purse.height = "18px";
        purse.top = "30px";
        purse.left = "5px";
        purse.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        purse.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        purse.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        content.addControl(purse);
        this.purseText = purse;

        const scrollViewer = new ScrollViewer("auctionScroll");
        scrollViewer.width = 1;
        scrollViewer.height = 0.45;
        scrollViewer.top = "50px";
        scrollViewer.thickness = 0;
        scrollViewer.background = BACKGROUND;
        scrollViewer.setPaddingInPixels(5, 5, 5, 5);
        scrollViewer.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        scrollViewer.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        content.addControl(scrollViewer);

        const stackPanel = new StackPanel("auctionStack");
        stackPanel.width = 1;
        stackPanel.height = 1;
        stackPanel.spacing = 0;
        stackPanel.adaptHeightToChildren = true;
        stackPanel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        stackPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        scrollViewer.addControl(stackPanel);
        this.stackPanel = stackPanel;

        const details = new Rectangle("auctionDetails");
        details.width = 1;
        details.height = 0.34;
        details.top = "-24px";
        details.background = "black";
        details.thickness = 0;
        details.setPaddingInPixels(5, 5, 5, 5);
        details.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        details.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        content.addControl(details);
        this.panelDetails = details;

        // Everything here is a round trip through a ledger, so "waiting" and
        // "somebody else got there first" are real things to be able to say.
        const status = new TextBlock("auctionStatus");
        status.text = "";
        status.color = "white";
        status.fontSize = "12px";
        status.height = "22px";
        status.textWrapping = TextWrapping.WordWrap;
        status.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        status.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        status.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        content.addControl(status);
        this.statusText = status;
    }

    private addTab(name: string, label: string, left: string, tab: Tab) {
        const btn = Button.CreateSimpleButton(name, label);
        btn.width = "66px";
        btn.height = "24px";
        btn.left = left;
        btn.color = "white";
        btn.thickness = 0;
        btn.fontSize = "14px";
        btn.background = this.tab === tab ? SELECTED : "black";
        btn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        btn.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        btn.metadata = { tab };
        this.tabs.addControl(btn);
        btn.onPointerClickObservable.add(() => {
            if (this.busy || this.tab === tab) return;
            this.tab = tab;
            this.selected = "";
            this.say("");
            this.highlightTabs();
            void this.reload();
        });
    }

    private highlightTabs() {
        this.tabs.children.forEach((child: any) => {
            if (!child.metadata || !child.metadata.tab) return;
            child.background = child.metadata.tab === this.tab ? SELECTED : "black";
        });
    }

    // ------------------------------------------------------------------ data

    /**
     * Ask the chain and the hall what is true, then draw the room around it.
     *
     * This owns the status line while it runs, and clears it when the read
     * works — so a "the hall did not answer" from a minute ago does not sit
     * there once it has. Anything with more to say than "this is current" says
     * it after awaiting this, not before.
     */
    private async reload(): Promise<void> {
        if (!this.wallet) {
            this.purseText.text = "No wallet — the chain could not be reached.";
            this.drawList([]);
            return;
        }

        try {
            await this.wallet.refresh();
            // The hall is read on every tab, not just Browse: it carries the
            // price history, and "what did this last go for" is the question a
            // seller wants answered while they are choosing a number.
            this.view = await this.wallet.hall();
            if (this.tab === "mine") this.listed = await this.wallet.myListings();
            this.say("");
        } catch (error) {
            this.say("The hall did not answer, so this may be out of date.", "orange");
        }

        this.purseText.text = "Purse: " + this.wallet.gold + " gold";
        this.drawList(this.rows());
    }

    private rows(): Row[] {
        if (!this.wallet) return [];

        if (this.tab === "browse") {
            // Your own listings are in the Mine tab. Accepting your own offer
            // moves nothing and the SDK refuses it, so it is not shown as
            // something to buy.
            return this.view.listings
                .filter((listing) => !listing.mine)
                .map((listing) => ({
                    id: listing.hash,
                    key: listing.key,
                    title: listing.qty > 1 ? listing.title + " x" + listing.qty : listing.title,
                    note: listing.price + "g",
                    listing,
                }));
        }

        if (this.tab === "mine") {
            return this.listed.map((listing) => ({
                id: listing.hash,
                key: listing.key,
                title: listing.qty > 1 ? listing.title + " x" + listing.qty : listing.title,
                note: listing.price + "g",
                listing,
            }));
        }

        // Selling lists what the chain says this player holds. Anything already
        // listed is locked and therefore not in the bag, so it cannot appear
        // twice by construction.
        const held: Row[] = [];
        Object.keys(this.wallet.inventory)
            .sort()
            .forEach((key) => {
                const qty = this.wallet.inventory[key] ?? 0;
                const item = this.wallet.priced(key);
                if (qty < 1 || !item) return;
                held.push({
                    id: key,
                    key,
                    title: item.title + " x" + qty,
                    // "each", because the browse and mine tabs put a lot total in
                    // this same column, and a bare number beside an "x10" reads as
                    // one of those (issue #14).
                    note: "worth " + item.value + "g each",
                    held: qty,
                });
            });
        return held;
    }

    // ------------------------------------------------------------------ list

    private drawList(rows: Row[]) {
        this.stackPanel.getDescendants().forEach((el) => el.dispose());
        this.panelDetails.getDescendants().forEach((el) => el.dispose());

        if (rows.length === 0) {
            this.drawEmpty();
            return;
        }

        if (!rows.some((row) => row.id === this.selected)) {
            this.selected = rows[0].id;
        }

        rows.forEach((row) => {
            const bloc = new Rectangle("row_" + row.id);
            bloc.width = 1;
            bloc.height = "25px";
            bloc.background = BACKGROUND;
            bloc.thickness = 0;
            bloc.metadata = { id: row.id };
            bloc.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
            bloc.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            this.stackPanel.addControl(bloc);

            const title = new TextBlock("rowTitle_" + row.id);
            title.text = row.title;
            title.color = "white";
            title.fontSize = "14px";
            title.paddingLeft = "5px";
            title.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
            title.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            title.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
            title.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            bloc.addControl(title);

            const note = new TextBlock("rowNote_" + row.id);
            note.text = row.note;
            note.color = "orange";
            note.fontSize = "13px";
            note.paddingRight = "5px";
            note.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
            note.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            note.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
            note.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            bloc.addControl(note);

            bloc.onPointerClickObservable.add(() => {
                if (this.busy) return;
                this.selected = row.id;
                this.say("");
                this.highlightRows();
                this.drawDetails(row);
            });
        });

        this.highlightRows();
        this.drawDetails(rows.find((row) => row.id === this.selected));
    }

    private highlightRows() {
        this.stackPanel.children.forEach((child: any) => {
            const id = child.metadata ? child.metadata.id : "";
            child.background = id === this.selected ? SELECTED : BACKGROUND;
        });
    }

    private drawEmpty() {
        const empty = new TextBlock("auctionEmpty");
        empty.color = "#FFF";
        empty.top = "5px";
        empty.left = "5px";
        empty.fontSize = "13px";
        empty.resizeToFit = true;
        empty.textWrapping = TextWrapping.WordWrap;
        empty.text = !this.wallet
            ? "Without a wallet there is nothing to trade with."
            : this.tab === "sell"
              ? "You are carrying nothing to sell. Buy something from a vendor first."
              : this.tab === "mine"
                ? "You have nothing listed. Anything you list locks on your own chain until it sells or you cancel it."
                : this.view.accounts === 0
                  ? "Nobody has been seen trading here yet, so there are no chains to read."
                  : "Nothing is for sale right now, across the " + this.view.accounts + " players this hall knows to ask.";
        empty.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        empty.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        empty.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        empty.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.stackPanel.addControl(empty);
    }

    // --------------------------------------------------------------- details

    private drawDetails(row: Row) {
        this.panelDetails.getDescendants().forEach((el) => el.dispose());
        if (!row) return;

        if (this.tab === "sell") {
            this.drawSell(row);
            return;
        }

        const listing = row.listing;
        if (!listing) return;

        const mine = this.tab === "mine";
        // Greyed rather than hidden, the way the vendor does it: not being able
        // to afford something is worth seeing, and it stops being true after a
        // sale of your own. The button still tries — the ledger is what refuses,
        // and its refusal is a better sentence than any guess made here.
        const affordable = mine || (this.wallet && this.wallet.gold >= listing.price);
        const action = this.actionButton(
            mine ? "Cancel" : "Buy " + listing.price + "g",
            mine ? "gray" : affordable ? "orange" : "#5a4a24"
        );
        action.onPointerClickObservable.add(() => {
            if (this.busy) return;
            void (mine ? this.cancel(listing) : this.buy(listing));
        });

        const lines = [
            listing.qty > 1 ? listing.price + " gold for " + listing.qty + " (" + round(listing.each) + " each)" : listing.price + " gold",
            mine ? "Listed by you, and locked until it sells or you cancel." : "Sold by " + shorten(listing.seller) + ".",
            describeHistory(this.view.history[listing.key]),
        ];
        this.describe(listing.title, lines);
    }

    /**
     * The listing form. The price is typed rather than stepped, because a
     * player asking 137 gold for something should not have to click 137 times,
     * and the number they choose is the only part of this the game has no
     * opinion about.
     *
     * The box is **per unit**, and everything visible says so: the label, the
     * quote line under the form, and the confirmation once it is signed. It used
     * to be labelled `Ask`, seeded with an item's per-unit shop price, and then
     * spent as the lot total — so stepping the quantity to ten and trusting the
     * number already in the box published a lot of ten at a tenth of the price on
     * screen (issue #14). A field whose meaning changed as a sibling control moved
     * was the failure; the quote line exists so the total is never implied.
     */
    private drawSell(row: Row) {
        const item = this.wallet ? this.wallet.priced(row.key) : undefined;
        const most = row.held ?? 1;
        let qty = 1;

        // Laid out from the right edge inwards: List, +, x1, -, the price box,
        // and its label. Every `left` below is the distance of that control's
        // right edge from the panel's, so the widths have to fit between them.
        const label = new TextBlock("auctionAsk");
        label.text = "Ask each";
        label.width = "52px";
        label.height = "24px";
        label.left = "-234px";
        label.color = "rgba(255,255,255,.7)";
        label.fontSize = "12px";
        label.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        label.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panelDetails.addControl(label);

        const each = new InputText("auctionEach");
        each.width = "70px";
        each.height = "24px";
        each.left = "-158px";
        each.color = "#FFF";
        each.fontSize = "13px";
        each.thickness = 0;
        each.background = BACKGROUND;
        each.placeholderText = "gold each";
        // The catalogue's `value` is the price of one, which is the right seed for
        // a per-unit box and was the wrong one for a lot total.
        each.text = String(item ? item.value : 1);
        each.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        each.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panelDetails.addControl(each);

        const quantity = new TextBlock("auctionQty");
        quantity.width = "34px";
        quantity.height = "24px";
        quantity.left = "-94px";
        quantity.color = "#FFF";
        quantity.fontSize = "13px";
        quantity.text = "x1";
        quantity.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        quantity.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panelDetails.addControl(quantity);

        /**
         * What this form is currently offering, in the same words the browse pane
         * uses for somebody else's listing. Written from the two live controls
         * rather than from either one, so the number the player is about to sign
         * is on screen before they sign it.
         */
        const quote = (): string => {
            const asked = Number(each.text.trim());
            if (!Number.isInteger(asked) || asked < 1) {
                return "Ask a whole number of gold for one of them, and at least 1.";
            }
            return qty > 1
                ? asked * qty + " gold for " + qty + " (" + asked + " each)."
                : asked + " gold for it.";
        };

        const lines = (): string[] => [
            quote(),
            "Listing locks it on your own chain, so it leaves your bag until it sells or you cancel it.",
            item && item.buyback > 0 ? "The shop would pay " + item.buyback + "g for one." : "The shop will not buy this.",
            describeHistory(this.view.history[row.key]),
        ];

        const body = this.describe(item ? item.title : row.key, lines(), 0.34);
        const requote = () => {
            body.text = lines()
                .filter((line) => line !== "")
                .join("\n");
        };
        each.onTextChangedObservable.add(requote);

        const step = (name: string, text: string, left: string, by: number) => {
            const btn = Button.CreateSimpleButton(name, text);
            btn.width = "22px";
            btn.height = "24px";
            btn.left = left;
            btn.background = "gray";
            btn.color = "white";
            btn.thickness = 0;
            btn.fontSize = "13px";
            btn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
            btn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
            btn.onPointerClickObservable.add(() => {
                if (this.busy) return;
                qty = Math.min(most, Math.max(1, qty + by));
                quantity.text = "x" + qty;
                requote();
            });
            this.panelDetails.addControl(btn);
        };
        step("auctionLess", "-", "-130px", -1);
        step("auctionMore", "+", "-70px", 1);

        const action = this.actionButton("List", "orange");
        action.onPointerClickObservable.add(() => {
            if (this.busy) return;
            void this.list(row, Number(each.text.trim()), qty);
        });
    }

    private actionButton(label: string, background: string): Button {
        const btn = Button.CreateSimpleButton("auctionAction", label);
        btn.width = "64px";
        btn.height = "24px";
        btn.left = "0px";
        btn.top = "0px";
        btn.color = "white";
        btn.background = background;
        btn.thickness = 0;
        btn.fontSize = "14px";
        btn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        btn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panelDetails.addControl(btn);
        return btn;
    }

    /**
     * `titleWidth` leaves room for whatever sits along the top of the block.
     *
     * Returns the body block, so a form whose numbers change while it is on screen
     * can rewrite what it says about them without redrawing the controls the
     * player is typing into.
     */
    private describe(title: string, lines: string[], titleWidth: number = 0.6): TextBlock {
        const name = new TextBlock("auctionName");
        name.text = title;
        name.color = "#FFF";
        name.fontSize = "16px";
        name.fontWeight = "bold";
        name.height = "24px";
        name.left = "0px";
        name.top = "0px";
        name.width = titleWidth;
        name.textWrapping = TextWrapping.Clip;
        name.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        name.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        name.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panelDetails.addControl(name);

        const body = new TextBlock("auctionBody");
        body.text = lines.filter((line) => line !== "").join("\n");
        body.color = "rgba(255,255,255,.7)";
        body.fontSize = "12px";
        body.top = "28px";
        body.left = "0px";
        body.width = 1;
        body.textWrapping = TextWrapping.WordWrap;
        body.resizeToFit = true;
        body.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        body.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        body.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        body.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panelDetails.addControl(body);
        return body;
    }

    // --------------------------------------------------------------- trading

    private async buy(listing: Listing): Promise<void> {
        this.busy = true;
        this.say("Settling " + listing.price + " gold against the listing...");
        // Losing the race to another buyer is a normal outcome here rather than
        // a fault, and the SDK's message already says which one happened. Every
        // path redraws first and reports afterwards, because `reload` owns the
        // status line while it runs.
        try {
            await this.wallet.accept(listing);
            this.selected = "";
            await this.after();
            this.say("Bought " + listing.title + " for " + listing.price + " gold.", "lightgreen");
        } catch (error) {
            await this.after();
            this.say(error.message, "orange");
        }
    }

    /** `each` is gold per unit, which is what the form asks for. */
    private async list(row: Row, each: number, qty: number): Promise<void> {
        this.busy = true;
        this.say("Publishing the listing...");
        try {
            const listing = await this.wallet.list(row.key, each, qty);
            this.tab = "mine";
            this.selected = listing.hash;
            this.highlightTabs();
            await this.after();
            // Both numbers, read back off the offer rather than off this form, so
            // the confirmation is what the chain now says and not what was typed.
            this.say(
                listing.qty > 1
                    ? "Listed " + listing.qty + " for " + listing.price + " gold (" + round(listing.each) + " each). It is locked until it sells."
                    : "Listed for " + listing.price + " gold. It is locked until it sells.",
                "lightgreen"
            );
        } catch (error) {
            await this.after();
            this.say(error.message, "orange");
        }
    }

    private async cancel(listing: Listing): Promise<void> {
        this.busy = true;
        this.say("Taking " + listing.title + " back...");
        try {
            await this.wallet.cancel(listing);
            this.selected = "";
            await this.after();
            this.say(listing.title + " is back in your bag.", "lightgreen");
        } catch (error) {
            await this.after();
            this.say(error.message, "orange");
        }
    }

    /**
     * Redraw before anything is reported, and only then let the buttons work
     * again — the rows are rebuilt during the reload, and a second click landing
     * on a row that is about to be replaced is the one way to sign twice.
     */
    private async after(): Promise<void> {
        try {
            await this.reload();
        } finally {
            this.busy = false;
        }
    }

    private say(message: string, color: string = "white") {
        if (!this.statusText) return;
        this.statusText.color = color;
        this.statusText.text = message;
    }
}

/** Price history is just history, and "never sold" is a different answer to "free". */
function describeHistory(sold: Sold | undefined): string {
    if (!sold) return "Never sold here.";
    return (
        "Last went for " +
        round(sold.last) +
        "g; " +
        sold.trades +
        (sold.trades === 1 ? " sale" : " sales") +
        ", " +
        round(sold.low) +
        "-" +
        round(sold.high) +
        "g."
    );
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function shorten(address: string): string {
    return address.length > 20 ? address.slice(0, 10) + "..." + address.slice(-4) : address;
}
