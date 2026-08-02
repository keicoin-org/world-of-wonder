import { Rectangle } from "@babylonjs/gui/2D/controls/rectangle";
import { Image } from "@babylonjs/gui/2D/controls/image";
import { TextBlock } from "@babylonjs/gui/2D/controls/textBlock";
import { Control } from "@babylonjs/gui/2D/controls/control";
import { Grid } from "@babylonjs/gui/2D/controls/grid";
import { Item } from "../../../../shared/types";
import { Rarity } from "../../../../shared/Class/Rarity";
import { Panel } from "./Panel";

/**
 * The bag, and what the chain says is in it.
 *
 * Upstream's inventory was `player_data.inventory`, a Colyseus schema the
 * server owned. What is drawn here now is `wallet.inventory` instead — a
 * balance read off the chain, the same one the vendor panel reads. Loot and
 * quest rewards are still the database's (SPEC gap, see README), so this
 * panel shows what was bought or sold on-chain and nothing else; it does not
 * merge the two, because papering over which one is authoritative is the
 * thing this fork exists to not do.
 */
export class Panel_Inventory extends Panel {
    // inventory tab
    private panel: Rectangle;
    private _inventoryGrid: Rectangle[] = [];
    private _goldUI: TextBlock;
    private _statusUI: TextBlock;
    private bgColor: string = "rgba(255,255,255,.1)";

    public sceneRendered = false;

    /** Set while a refresh is in flight, so two do not race each other. */
    private _refreshing = false;

    constructor(_UI, _currentPlayer, options) {
        super(_UI, _currentPlayer, options);

        // some ui must be constantly refreshed as things change
        this._scene.registerAfterRender(() => {
            // refresh
            if (!this.sceneRendered) {
                this.createContent();
            }
            this.sceneRendered = true;

            this.update();
        });
    }

    private get wallet() {
        return this._game.wallet;
    }

    // open panel
    public open() {
        super.open();
        void this.refresh();
    }

    public close() {
        super.close();
        this._UI._InventoryDropdown.hideDropdown();
    }

    // refresh panel
    public update() {
        super.update();
    }

    // create panel
    private createContent() {
        let panel: Rectangle = this._panelContent;

        // if already exists
        panel.children.forEach((el) => {
            el.dispose();
        });

        // panel title
        var goldTitle = new TextBlock("goldTitle");
        goldTitle.text = "Gold: 0";
        goldTitle.fontSize = "12px";
        goldTitle.color = "rgba(255,255,255,.9)";
        goldTitle.top = "-5px";
        goldTitle.left = "5px";
        goldTitle.fontSize = "14px";
        goldTitle.width = 1;
        goldTitle.height = "30px;";
        goldTitle.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        goldTitle.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        goldTitle.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        goldTitle.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        panel.addControl(goldTitle);
        this._goldUI = goldTitle;

        // A purchase or a sale is a round trip through a ledger, not a message,
        // so there is somewhere to say the chain has not answered yet.
        var statusText = new TextBlock("inventoryStatus");
        statusText.text = "";
        statusText.color = "orange";
        statusText.fontSize = "12px";
        statusText.top = "-5px";
        statusText.left = "0px";
        statusText.width = 1;
        statusText.height = "16px";
        statusText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        statusText.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        statusText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        statusText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        panel.addControl(statusText);
        this._statusUI = statusText;

        ///////////////////////////////////////////////////////

        let inventoryGrid = new Rectangle("inventoryGrid");
        inventoryGrid.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
        inventoryGrid.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        inventoryGrid.left = "0px";
        inventoryGrid.top = "0px";
        inventoryGrid.width = 1;
        inventoryGrid.height = 1;
        inventoryGrid.thickness = 0;
        panel.addControl(inventoryGrid);

        let panelWidth = panel.widthInPixels;
        let inventorySpace = this._game.config.PLAYER_INVENTORY_SPACE;
        let inventorySpaceW = 5;
        let size = panelWidth / 5;
        let inventorySpaceCols = inventorySpaceW;
        let inventorySpaceRows = inventorySpace / inventorySpaceW;

        // create grid
        let grid = new Grid();
        grid.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        grid.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        grid.left = "0px;";
        grid.width = 1;
        grid.heightInPixels = inventorySpaceRows * (size + 10);
        inventoryGrid.addControl(grid);

        for (let i = 0; i <= inventorySpaceW; i++) {
            grid.addColumnDefinition(size, true);
        }

        for (let i = 0; i <= inventorySpaceRows; i++) {
            grid.addRowDefinition(size, true);
        }

        this._inventoryGrid = [];

        let i = 0;
        for (let r = 0; r < inventorySpaceRows; r++) {
            for (let col = 0; col < inventorySpaceCols; col++) {
                if (i < this._game.config.PLAYER_INVENTORY_SPACE) {
                    const inventorySpace = new Rectangle("inventorySpace_" + i);
                    inventorySpace.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
                    inventorySpace.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
                    inventorySpace.top = 0.1;
                    inventorySpace.left = 0.1;
                    inventorySpace.width = 0.9;
                    inventorySpace.height = 0.9;
                    inventorySpace.background = this.bgColor;
                    inventorySpace.thickness = 2;
                    inventorySpace.color = this.bgColor;
                    inventorySpace.cornerRadius = 0;
                    grid.addControl(inventorySpace, r, col);

                    this._inventoryGrid.push(inventorySpace);

                    i++;
                }
            }
        }

        //
        void this.refresh();
    }

    updateGold() {
        if (this._goldUI) {
            this._goldUI.text = "Gold: " + (this.wallet ? this.wallet.gold : 0);
        }
    }

    private say(message: string) {
        if (this._statusUI) {
            this._statusUI.text = message;
        }
    }

    ///////////////////////////////////////
    ///////////////////////////////////////
    // INVENTORY PANEL

    /** Ask the chain what we hold, then draw the bag around the answer. */
    public async refresh() {
        if (this._inventoryGrid.length < 1) {
            return false;
        }

        if (!this.wallet) {
            this.say("No wallet — the chain could not be reached.");
            this.drawGrid({});
            return;
        }

        if (this._refreshing) {
            return;
        }
        this._refreshing = true;
        this.say("Checking the chain...");
        try {
            await this.wallet.refresh();
            this.say("");
        } catch (error) {
            this.say("The chain did not answer, so this bag may be stale.");
        } finally {
            this._refreshing = false;
        }

        this.drawGrid(this.wallet.inventory);
    }

    /** Clear every slot, then fill as many as the chain says we hold one of. */
    private drawGrid(inventory: { [key: string]: number }) {
        this._inventoryGrid.forEach((child) => {
            child.getDescendants().forEach((el) => {
                el.dispose();
            });
            child.metadata = {};
            child.background = this.bgColor;
            child.color = this.bgColor;
            this._UI._Tooltip.close();
        });

        const held = Object.keys(inventory)
            .filter((key) => inventory[key] > 0)
            .sort();

        held.forEach((key, index) => {
            const child = this._inventoryGrid[index];
            if (!child) return; // more archetypes than slots is a config problem, not a crash

            const item = this._game.getGameData("item", key) as Item;
            if (!item) return;

            const qty = inventory[key];

            let color = Rarity.getColor(item);
            child.background = color.bg;
            child.thickness = 2;
            child.color = color.color;

            child.metadata = { item, key };

            // add item icon
            var imageData = this._loadedAssets[item.icon];
            var img = new Image("itemImage_" + key, imageData);
            img.stretch = Image.STRETCH_FILL;
            child.addControl(img);

            // add item qty
            const itemTxtQty = new TextBlock("itemTxtQty" + index);
            itemTxtQty.text = String(qty);
            itemTxtQty.color = "#FFF";
            itemTxtQty.top = "-2px";
            itemTxtQty.left = "-2px";
            itemTxtQty.fontSize = "12px;";
            itemTxtQty.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
            itemTxtQty.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
            itemTxtQty.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
            child.addControl(itemTxtQty);

            // on item hover
            child.onPointerEnterObservable.clear();
            child.onPointerEnterObservable.add(() => {
                if (child.metadata.item) {
                    this._UI._Tooltip.refresh("item", item, child);
                }
            });
            // on item unhover
            child.onPointerOutObservable.clear();
            child.onPointerOutObservable.add(() => {
                if (child.metadata.item) {
                    this._UI._Tooltip.close();
                }
            });
        });

        if (this.wallet && held.length === 0 && this._statusUI && this._statusUI.text === "") {
            this.say("Nothing here yet - buy something from a vendor.");
        }

        this.updateGold();
    }
}
