
--
-- This file is executed in full on every boot, so every statement in it has to
-- be one that a second boot can run again without changing anything.
--
-- It used to open each table with DROP TABLE IF EXISTS, which made this adapter
-- the only one in the repo that threw the world away on restart -- SQLite has
-- always been CREATE TABLE IF NOT EXISTS and nothing else. That drop is what
-- made characters.id restart at 1 while the durable reward tables below kept
-- rows naming those ids, so a reward authored for one player could resolve to
-- whoever inherited the number after a restart (issue #21). The primary keys
-- and AUTO_INCREMENT now live inside the CREATE TABLE statements, where they
-- are established once rather than re-applied -- a bare ALTER TABLE ADD PRIMARY
-- KEY is an error the second time, which is the other reason the drops were
-- here.
--
-- Keep the statement separator out of the prose in this file, comments
-- included -- createDatabase() splits on it, and a sentence cut in half takes
-- the statement underneath it along.
--
-- USERS

CREATE TABLE IF NOT EXISTS `users` (
	`id`			int(10) NOT NULL AUTO_INCREMENT,
	`username`		varchar(255),
	`password`		varchar(255),
	`token`			varchar(255),
	PRIMARY KEY (`id`)
);

--
-- CHARACTERS
CREATE TABLE IF NOT EXISTS `characters` (
	`id`			int(10) NOT NULL AUTO_INCREMENT,
	`user_id`		int(10),
	`name`			varchar(255),
	`race`			varchar(255),
	`material`		int(10),
	`head`			varchar(255),
	`location`		varchar(255),
	`level`			int(10),
	`experience`	int(10),
	`health`		int(10),
	`mana`			int(10),
	`x`				decimal(10,3),
	`y` 			decimal(10,3),
	`z`				decimal(10,3),
	`rot`			decimal(10,3),
	`gold`			int(10),
	`strength`		int(10),
	`endurance`		int(10),
	`agility`		int(10),
	`intelligence`	int(10),
	`wisdom`		int(10),
	`points`		int(10),
	`online`		int(10),
	PRIMARY KEY (`id`)
);

--
-- CHARACTER INVENTORY

CREATE TABLE IF NOT EXISTS `character_inventory` (
	`id`			int(10) NOT NULL AUTO_INCREMENT,
	`owner_id`		int(10),
	`order`			int(10),
	`qty`			int(10),
	`key`			varchar(255),
	PRIMARY KEY (`id`)
);

--
-- CHARACTER ABILITIES

CREATE TABLE IF NOT EXISTS `character_abilities` (
	`id`			int(10) NOT NULL AUTO_INCREMENT,
	`owner_id`		int(10),
	`key`			varchar(255),
	PRIMARY KEY (`id`)
);

--
-- CHARACTER EQUIPMENT

CREATE TABLE IF NOT EXISTS `character_equipment` (
	`id`			int(10) NOT NULL AUTO_INCREMENT,
	`owner_id`		int(10),
	`slot`			int(10),
	`key`			varchar(255),
	PRIMARY KEY (`id`)
);

--
-- CHARACTER QUESTS

CREATE TABLE IF NOT EXISTS `character_quests` (
	`id`			int(10) NOT NULL AUTO_INCREMENT,
	`owner_id`		int(10),
	`key`			varchar(255),
	`status`		int(10),
	`qty`			int(10),
	PRIMARY KEY (`id`)
);

--
-- CHARACTER HOTBAR

CREATE TABLE IF NOT EXISTS `character_hotbar` (
	`id`			int(10) NOT NULL AUTO_INCREMENT,
	`owner_id`		int(10),
	`key`			varchar(255),
	`type`			varchar(255),
	`digit`			int(10),
	PRIMARY KEY (`id`)
);

--
-- STARTING PURSES
--
-- Which addresses have already been given a starting purse, and which character
-- claimed each one. Not dropped on startup: the purse is a mint, and a record
-- that a restart forgot would let every character in the world claim a second
-- one. It holds no balance and authorizes nothing.
--
-- Keyed on the address rather than on the character because an address is never
-- reissued by anything, where a character id is only stable for as long as the
-- characters table is. It stopped being dropped on boot with issue #21, and the
-- address key is what would keep this table honest if that ever regressed.

CREATE TABLE IF NOT EXISTS `starting_purses` (
	`address`		varchar(255) NOT NULL,
	`owner_id`		int(10),
	`amount`		int(10),
	`granted_at`	bigint,
	PRIMARY KEY (`address`)
);

--
-- REWARD PAYMENTS
--
-- The record of which server-authored rewards have already been minted on the
-- chain. A restart that forgot it would pay every one of them a second time. It
-- holds no balance and authorizes nothing. The chain is still the only ledger.
--
-- A reward id names a character by `characters.id`, so this table only means
-- anything for as long as that id keeps meaning the same character. It used to
-- not: this adapter dropped and recreated `characters` on every boot, the
-- AUTO_INCREMENT restarted at 1, and a row written for one player could resolve
-- to whoever was handed the number next. That is fixed above, at the cause,
-- rather than by teaching this table to distrust its own ids (issue #21).
--
-- This table itself goes away with the #6 migration, when the last producer
-- comes off InventoryAuthority.pay() and onto the outbox below.

CREATE TABLE IF NOT EXISTS `reward_payments` (
	`id`			varchar(255) NOT NULL,
	`owner_id`		int(10),
	`address`		varchar(255),
	`gold`			int(10),
	`items`			varchar(255),
	`paid_at`		bigint,
	PRIMARY KEY (`id`)
);

--
-- REWARD OUTBOX
--
-- Rewards the server has authored and the chain has not finished taking.
-- src/server/kei/Outbox.ts is the state machine and explains it. This is only
-- where it lives. Neither of these two tables holds a balance and neither
-- authorizes anything -- they are workflow state and chain receipts, and the
-- chain is still the only ledger.
--
-- payload is the immutable list of legs, written by the one INSERT that enqueues
-- a reward. Neither database adapter here exposes a transaction, so that single
-- statement is what makes authoring atomic. The rows in reward_outbox_legs are
-- derived from the payload on the first claim and deriving them again does
-- nothing, so a crash on either side of either step loses no reward and
-- duplicates none.
--
-- These rows name characters by id too, and used to be protected from the reuse
-- above by a startup quarantine that held the whole pending queue on this
-- adapter. That quarantine is gone with the reuse it defended against: with
-- `characters` no longer dropped, holding every pending reward on every MySQL
-- boot would mean this adapter never delivers one (issue #21).

CREATE TABLE IF NOT EXISTS `reward_outbox` (
	`id`			varchar(190) NOT NULL,
	`owner_id`		int(10),
	`address`		varchar(255),
	`issuer`		varchar(255),
	`payload`		text,
	`replayable`	int(1) DEFAULT 0,
	`state`			varchar(16) DEFAULT 'pending',
	`attempts`		int(10) DEFAULT 0,
	`lease_until`	bigint DEFAULT 0,
	`reason`		varchar(500),
	`enqueued_at`	bigint,
	`settled_at`	bigint,
	PRIMARY KEY (`id`)
);

--
-- One asset moving to one address. units is raw units as a decimal string,
-- because a JS number cannot carry raw units of anything with decimals and a
-- reward is a bad place to lose the bottom of a number. previous is the issuer
-- frontier the mint was aimed at, recorded before it was sent: an account chain
-- is linear and single-writer, so exactly one block can ever follow a given one,
-- which is what lets an ambiguous timeout be reconciled by block identity rather
-- than by reading a balance players are free to change themselves.

CREATE TABLE IF NOT EXISTS `reward_outbox_legs` (
	`reward_id`		varchar(190) NOT NULL,
	`leg`			int(10) NOT NULL,
	`kind`			varchar(8),
	`key`			varchar(255),
	`units`			varchar(32),
	`state`			varchar(16) DEFAULT 'pending',
	`attempts`		int(10) DEFAULT 0,
	`previous`		varchar(128),
	`receipt`		varchar(128),
	`error`			varchar(255),
	PRIMARY KEY (`reward_id`, `leg`)
);