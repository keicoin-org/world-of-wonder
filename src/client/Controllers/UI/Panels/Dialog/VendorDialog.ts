/**
 * The shop, and the one place in this game where a player spends money that is
 * actually theirs.
 *
 * Upstream's vendor asked the room to buy something and the room edited a row:
 * gold went down because the server said so. Nothing on this panel is the
 * server's word for anything any more. Prices come from the shop, but the purse
 * is read off the chain, paying is a transfer the player's own wallet signs, and
 * an item counts as bought only once the chain says it arrived.
 *
 * That is why these buttons have more states than upstream's had. A purchase is
 * a round trip through a ledger rather than a message, so "waiting" is a real
 * thing that can happen to a player, and the panel has to be able to say it.
 */

import { Control } from "@babylonjs/gui/2D/controls/control";
import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { ScrollViewer } from "@babylonjs/gui/2D/controls/scrollViewers/scrollViewer";
import { StackPanel } from "@babylonjs/gui/2D/controls/stackPanel";
import { Image } from "@babylonjs/gui/2D/controls/image";
import { TextBlock, TextWrapping } from "@babylonjs/gui/2D/controls/textBlock";
import { Button } from "@babylonjs/gui/2D/controls/button";
import { Panel_Dialog } from "../..";

/** One line in the list, whichever way round the shop is facing. */
interface Row {
    key: string;
    title: string;
    /**
     * What **one** costs to buy, or pays to sell — per unit, unlike the auction's
     * `Listing.price`, which is a lot total. Every use below multiplies it by the
     * stepper's quantity, and confusing the two is issue #14.
     */
    price: number;
    /** How many the chain says the player holds. */
    held: number;
}

export class VendorDialog {
    private panel: Panel_Dialog;
    private currentDialog;

    private stackPanel: StackPanel;
    private panelDetails: Rectangle;
    private purseText: TextBlock;
    private statusText: TextBlock;

    private mode: "buy" | "sell" = "buy";
    private selected: string = "";
    /** Set while something is in flight, so nothing gets signed twice. */
    private busy: boolean = false;

    private backgroundColor = "#292929";
    private backgroundSelected = "green";

    constructor(panel: Panel_Dialog, vendor) {
        this.panel = panel;
        this.currentDialog = vendor;
        this.create();
        void this.reload();
    }

    private get wallet() {
        return this.panel._game.wallet;
    }

    /** Ask the chain what the player has, then draw the shop around the answer. */
    private async reload(): Promise<void> {
        if (this.wallet) {
            try {
                await this.wallet.refresh();
            } catch (error) {
                this.say("The chain did not answer, so these numbers may be stale.", "orange");
            }
        }
        this.drawPurse();
        this.drawList();
    }

    // ------------------------------------------------------------------ frame

    private create() {
        this.panel._panelContent.getDescendants().forEach((el) => el.dispose());

        const backBtn = Button.CreateSimpleButton("backBtn", "Back");
        backBtn.left = "0px";
        backBtn.top = "0px";
        backBtn.width = "60px";
        backBtn.height = "24px";
        backBtn.background = "black";
        backBtn.color = "white";
        backBtn.thickness = 0;
        backBtn.fontSize = "14px";
        backBtn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        backBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panel._panelContent.addControl(backBtn);
        backBtn.onPointerDownObservable.add(() => {
            this.panel.nextStep(0);
        });

        this.tab("buyTab", "Buy", "-62px", "buy");
        this.tab("sellTab", "Sell", "0px", "sell");

        // What the chain says they are carrying. Upstream had no equivalent,
        // because the number in the corner of the bag was already the truth.
        const purse = new TextBlock("purseText");
        purse.text = "";
        purse.color = "orange";
        purse.fontSize = "13px";
        purse.height = "18px";
        purse.top = "26px";
        purse.left = "2px";
        purse.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        purse.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        purse.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panel._panelContent.addControl(purse);
        this.purseText = purse;

        const scrollViewer = new ScrollViewer("scrollViewer");
        scrollViewer.width = 1;
        scrollViewer.height = 0.45;
        scrollViewer.top = "46px";
        scrollViewer.thickness = 0;
        scrollViewer.background = this.backgroundColor;
        scrollViewer.setPaddingInPixels(5, 5, 5, 5);
        scrollViewer.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        scrollViewer.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panel._panelContent.addControl(scrollViewer);

        const stackPanel = new StackPanel("stackPanel");
        stackPanel.width = 1;
        stackPanel.height = 1;
        stackPanel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        stackPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        stackPanel.spacing = 0;
        stackPanel.adaptHeightToChildren = true;
        scrollViewer.addControl(stackPanel);
        this.stackPanel = stackPanel;

        const details = new Rectangle("ItemDetailsBloc");
        details.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        details.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        details.width = 1;
        details.height = 0.37;
        details.top = "-22px";
        details.background = "black";
        details.setPaddingInPixels(5, 5, 5, 5);
        details.thickness = 0;
        this.panel._panelContent.addControl(details);
        this.panelDetails = details;

        // A purchase can fail in ways a message send could not — being too poor,
        // or a chain that has not caught up yet — so there is somewhere to say so.
        const status = new TextBlock("statusText");
        status.text = "";
        status.color = "white";
        status.fontSize = "12px";
        status.height = "20px";
        status.textWrapping = TextWrapping.WordWrap;
        status.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        status.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        status.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        this.panel._panelContent.addControl(status);
        this.statusText = status;
    }

    private tab(name: string, label: string, left: string, mode: "buy" | "sell") {
        const btn = Button.CreateSimpleButton(name, label);
        btn.width = "60px";
        btn.height = "24px";
        btn.top = "0px";
        btn.left = left;
        btn.color = "white";
        btn.thickness = 0;
        btn.fontSize = "14px";
        btn.background = this.mode === mode ? this.backgroundSelected : "black";
        btn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        btn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.panel._panelContent.addControl(btn);
        btn.onPointerDownObservable.add(() => {
            if (this.busy || this.mode === mode) return;
            this.mode = mode;
            this.selected = "";
            this.create();
            void this.reload();
        });
    }

    // ------------------------------------------------------------------- list

    private drawPurse() {
        if (!this.wallet) {
            this.purseText.text = "No wallet — the chain could not be reached.";
            return;
        }
        this.purseText.text = "Purse: " + this.wallet.gold + " gold";
    }

    /**
     * Buying lists what this vendor stocks. Selling lists what the player
     * actually holds, which is a question only the chain can answer.
     */
    private rows(): Row[] {
        if (!this.wallet) return [];

        if (this.mode === "sell") {
            return this.wallet.sellable().map((held) => ({
                key: held.item.key,
                title: held.item.title,
                price: held.item.buyback,
                held: held.qty,
            }));
        }

        const stocked: Row[] = [];
        (this.currentDialog.items ?? []).forEach((entry) => {
            const priced = this.wallet.priced(entry.key);
            if (!priced) return;
            stocked.push({
                key: entry.key,
                title: priced.title,
                price: priced.value,
                held: this.wallet.inventory[entry.key] ?? 0,
            });
        });
        return stocked;
    }

    private drawList() {
        this.stackPanel.getDescendants().forEach((el) => el.dispose());

        const rows = this.rows();
        if (rows.length === 0) {
            this.emptyList();
            this.panelDetails.getDescendants().forEach((el) => el.dispose());
            return;
        }

        if (!rows.some((row) => row.key === this.selected)) {
            this.selected = rows[0].key;
        }

        rows.forEach((row) => {
            const blocContainer = new Rectangle("bloc_" + row.key);
            blocContainer.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            blocContainer.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
            blocContainer.top = "0px";
            blocContainer.left = "0px";
            blocContainer.width = 1;
            blocContainer.height = "25px";
            blocContainer.background = this.backgroundColor;
            blocContainer.thickness = 0;
            blocContainer.metadata = { key: row.key };
            this.stackPanel.addControl(blocContainer);

            const blockTitle = new TextBlock("title_" + row.key);
            blockTitle.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            blockTitle.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
            blockTitle.paddingLeft = "5px";
            blockTitle.text = this.mode === "sell" ? row.title + " x" + row.held : row.title;
            blockTitle.fontSize = "14px";
            blockTitle.color = "white";
            blockTitle.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            blockTitle.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
            blocContainer.addControl(blockTitle);

            const blockPrice = new TextBlock("price_" + row.key);
            blockPrice.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            blockPrice.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
            blockPrice.paddingRight = "5px";
            blockPrice.text = row.price + "g";
            blockPrice.fontSize = "13px";
            blockPrice.color = "orange";
            blockPrice.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
            blockPrice.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
            blocContainer.addControl(blockPrice);

            blocContainer.onPointerClickObservable.add(() => {
                if (this.busy) return;
                this.selected = row.key;
                this.say("");
                this.highlight();
                this.drawDetails(row);
            });
        });

        this.highlight();
        this.drawDetails(rows.find((row) => row.key === this.selected));
    }

    private highlight() {
        this.stackPanel.children.forEach((child: any) => {
            const key = child.metadata ? child.metadata.key : "";
            child.background = key === this.selected ? this.backgroundSelected : this.backgroundColor;
        });
    }

    private emptyList() {
        const empty = new TextBlock("emptyText");
        empty.color = "#FFF";
        empty.top = "5px";
        empty.left = "5px";
        empty.resizeToFit = true;
        empty.fontSize = "13px";
        empty.text = !this.wallet
            ? "Without a wallet there is nothing to trade with."
            : this.mode === "sell"
              ? "You are carrying nothing I would buy."
              : "I have nothing to sell you today.";
        empty.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        empty.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        empty.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        empty.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        empty.textWrapping = TextWrapping.WordWrap;
        this.stackPanel.addControl(empty);
    }

    // ---------------------------------------------------------------- details

    private drawDetails(row: Row) {
        this.panelDetails.getDescendants().forEach((el) => el.dispose());
        if (!row) return;

        const item = this.panel._game.getGameData("item", row.key);
        let quantity = 1;

        const actionBloc = new Rectangle("actionBloc");
        actionBloc.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        actionBloc.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        actionBloc.top = "0px";
        actionBloc.left = "0px";
        actionBloc.width = 1;
        actionBloc.height = "30px";
        actionBloc.thickness = 0;
        this.panelDetails.addControl(actionBloc);

        const actionBtn = Button.CreateSimpleButton("actionBtn", "");
        actionBtn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        actionBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        actionBtn.left = this.mode === "buy" ? "-29px" : "0px";
        actionBtn.top = "0px";
        actionBtn.width = this.mode === "buy" ? "60px" : "90px";
        actionBtn.height = "24px";
        actionBtn.color = "white";
        actionBtn.thickness = 0;
        actionBtn.fontSize = "14px";
        actionBtn.hoverCursor = this.panel._UI._Cursor.get(this.mode);
        actionBloc.addControl(actionBtn);

        const affordable = () => this.mode === "sell" || (this.wallet && this.wallet.gold >= row.price * quantity);

        const redraw = () => {
            if (actionBtn.textBlock) {
                actionBtn.textBlock.text = this.mode === "buy" ? "Buy " + quantity : "Sell 1";
            }
            // Greyed rather than hidden: not being able to afford something is
            // worth seeing, and it stops being true when the quantity comes down.
            actionBtn.background = affordable() ? "orange" : "#5a4a24";
        };
        redraw();

        if (this.mode === "buy") {
            actionBloc.addControl(
                this.stepper("minusBtn", "-", "-95px", () => {
                    if (this.busy || quantity <= 1) return;
                    quantity--;
                    redraw();
                })
            );
            actionBloc.addControl(
                this.stepper("plusBtn", "+", "0px", () => {
                    if (this.busy || quantity >= 99) return;
                    quantity++;
                    redraw();
                })
            );
        }

        actionBtn.onPointerClickObservable.add(() => {
            if (this.busy) return;
            void (this.mode === "buy" ? this.buy(row, quantity) : this.sell(row));
        });

        this.describe(item, row);
    }

    private stepper(name: string, label: string, left: string, onClick: () => void): Button {
        const btn = Button.CreateSimpleButton(name, label);
        btn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        btn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        btn.left = left;
        btn.top = "0px";
        btn.width = "24px";
        btn.height = "24px";
        btn.background = "gray";
        btn.color = "white";
        btn.thickness = 0;
        btn.onPointerClickObservable.add(onClick);
        return btn;
    }

    /** Icon, name, description, and what the shop is prepared to do about it. */
    private describe(item, row: Row) {
        const scrollViewerDetails = new ScrollViewer("scrollViewerDetails");
        scrollViewerDetails.width = 1;
        scrollViewerDetails.height = 1;
        scrollViewerDetails.top = "30px";
        scrollViewerDetails.thickness = 0;
        scrollViewerDetails.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        scrollViewerDetails.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        this.panelDetails.addControl(scrollViewerDetails);

        const stackPanel = new StackPanel("detailsStack");
        stackPanel.width = 1;
        stackPanel.height = 1;
        stackPanel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        stackPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        stackPanel.spacing = 5;
        stackPanel.adaptHeightToChildren = true;
        scrollViewerDetails.addControl(stackPanel);

        const titleBloc = new Rectangle("titleBloc");
        titleBloc.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        titleBloc.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        titleBloc.top = "5px";
        titleBloc.left = "0px";
        titleBloc.width = 1;
        titleBloc.height = "35px";
        titleBloc.thickness = 0;
        stackPanel.addControl(titleBloc);

        if (item && item.icon && this.panel._loadedAssets[item.icon]) {
            const imageBLoc = new Rectangle("imageBLoc");
            imageBLoc.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
            imageBLoc.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
            imageBLoc.top = "0px";
            imageBLoc.left = "0px";
            imageBLoc.width = "30px";
            imageBLoc.height = "30px";
            imageBLoc.thickness = 0;
            titleBloc.addControl(imageBLoc);

            const img = new Image("itemImage_" + row.key, this.panel._loadedAssets[item.icon]);
            img.stretch = Image.STRETCH_FILL;
            imageBLoc.addControl(img);
        }

        const name = new TextBlock("itemName");
        name.width = 0.7;
        name.color = "#FFF";
        name.top = "0px";
        name.left = "40px";
        name.fontSize = "18px";
        name.fontWeight = "bold";
        name.resizeToFit = true;
        name.textWrapping = TextWrapping.WordWrap;
        name.text = row.title;
        name.lineSpacing = "-4px";
        name.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        name.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        name.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        name.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        titleBloc.addControl(name);

        const description = new TextBlock("itemDescription");
        description.color = "rgba(255,255,255,.6)";
        description.top = 0;
        description.left = "0px";
        description.fontSize = "12px";
        description.textWrapping = TextWrapping.WordWrap;
        description.resizeToFit = true;
        description.text = item && item.description ? item.description : "";
        description.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        description.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        description.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        description.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        stackPanel.addControl(description);

        const priceLine = new TextBlock("itemPrice");
        priceLine.top = 0;
        priceLine.left = "0px";
        priceLine.fontSize = "12px";
        priceLine.color = "orange";
        priceLine.textWrapping = TextWrapping.WordWrap;
        priceLine.resizeToFit = true;
        priceLine.text =
            this.mode === "buy"
                ? "Cost: " + row.price + " gold" + (row.held > 0 ? "   (you own " + row.held + ")" : "")
                : "I will pay " + row.price + " gold, and you have " + row.held + ".";
        priceLine.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        priceLine.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        priceLine.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        priceLine.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        stackPanel.addControl(priceLine);
    }

    // ---------------------------------------------------------------- trading

    /**
     * Paying is one signature and delivery is another, so there is a real gap
     * between them in which the player is owed something. Say so while it lasts.
     */
    private async buy(row: Row, quantity: number): Promise<void> {
        if (!this.wallet) return this.say("There is no wallet to pay with.", "orange");

        this.busy = true;
        this.say("Paying " + row.price * quantity + " gold...");
        try {
            await this.wallet.buy(row.key, quantity);
            this.say("Bought " + quantity + " " + row.title + ".", "lightgreen");
        } catch (error) {
            this.say(error.message, "orange");
        } finally {
            this.busy = false;
            await this.reload();
        }
    }

    private async sell(row: Row): Promise<void> {
        if (!this.wallet) return this.say("There is no wallet to be paid into.", "orange");

        this.busy = true;
        this.say("Handing over your " + row.title + "...");
        try {
            const paid = await this.wallet.sell(row.key);
            this.say("Sold for " + paid + " gold.", "lightgreen");
        } catch (error) {
            this.say(error.message, "orange");
        } finally {
            this.busy = false;
            await this.reload();
        }
    }

    private say(message: string, color: string = "white") {
        if (!this.statusText) return;
        this.statusText.color = color;
        this.statusText.text = message;
    }
}
