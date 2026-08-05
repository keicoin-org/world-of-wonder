
--
-- USERS

DROP TABLE IF EXISTS `users`;
CREATE TABLE IF NOT EXISTS `users` (
	`id`			int(10) NOT NULL,
	`username`		varchar(255),
	`password`		varchar(255),
	`token`			varchar(255)
);
ALTER TABLE `users` ADD PRIMARY KEY (`id`);
ALTER TABLE `users` MODIFY `id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- USERS
DROP TABLE IF EXISTS `characters`;
CREATE TABLE IF NOT EXISTS `characters` (
	`id`			int(10) NOT NULL,
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
	`online`		int(10)
);
ALTER TABLE `characters` ADD PRIMARY KEY (`id`);
ALTER TABLE `characters` MODIFY `id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- USERS

DROP TABLE IF EXISTS `character_inventory`;
CREATE TABLE IF NOT EXISTS `character_inventory` (
	`id`			int(10) NOT NULL,
	`owner_id`		int(10),
	`order`			int(10),
	`qty`			int(10),
	`key`			varchar(255)
);
ALTER TABLE `character_inventory` ADD PRIMARY KEY (`id`);
ALTER TABLE `character_inventory` MODIFY `id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- USERS

DROP TABLE IF EXISTS `character_abilities`;
CREATE TABLE IF NOT EXISTS `character_abilities` (
	`id`			int(10) NOT NULL,
	`owner_id`		int(10),
	`key`			varchar(255)
);
ALTER TABLE `character_abilities` ADD PRIMARY KEY (`id`);
ALTER TABLE `character_abilities` MODIFY `id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- USERS

DROP TABLE IF EXISTS `character_equipment`;
CREATE TABLE IF NOT EXISTS `character_equipment` (
	`id`			int(10) NOT NULL,
	`owner_id`		int(10),
	`slot`			int(10),
	`key`			varchar(255)
);
ALTER TABLE `character_equipment` ADD PRIMARY KEY (`id`);
ALTER TABLE `character_equipment` MODIFY `id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- USERS

DROP TABLE IF EXISTS `character_quests`;
CREATE TABLE IF NOT EXISTS `character_quests` (
	`id`			int(10) NOT NULL,
	`owner_id`		int(10),
	`key`			varchar(255),
	`status`		int(10),
	`qty`			int(10)
);
ALTER TABLE `character_quests` ADD PRIMARY KEY (`id`);
ALTER TABLE `character_quests` MODIFY `id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- USERS

DROP TABLE IF EXISTS `character_hotbar`;
CREATE TABLE IF NOT EXISTS `character_hotbar` (
	`id`			int(10) NOT NULL,
	`owner_id`		int(10),
	`key`			varchar(255),
	`type`			varchar(255),
	`digit`			int(10)	
);
ALTER TABLE `character_hotbar` ADD PRIMARY KEY (`id`);
ALTER TABLE `character_hotbar` MODIFY `id` int(10) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

--
-- REWARD PAYMENTS
--
-- Not dropped on startup, unlike everything above it. This is the record of
-- which server-authored rewards have already been minted on the chain, and a
-- restart that forgot it would pay every one of them a second time. It holds no
-- balance and authorizes nothing. The chain is still the only ledger. Keep the
-- statement separator out of the prose in this file, comments included --
-- createDatabase() splits on it, and a sentence cut in half takes the statement
-- underneath it along.
--
-- Known limitation on this adapter, and only this one. Every table above is
-- dropped and recreated on each boot, so `characters.id` restarts at 1 while
-- these rows survive — and a reward id names a character by that id. A fresh
-- character can therefore inherit a previous incarnation's paid quests and go
-- unpaid for them. That is the direction this design errs in on purpose: a
-- stale row under-pays, and dropping the table would over-mint. The real fix is
-- a stable per-character identity, which arrives with wallet binding (issue #6).
-- SQLite, which is what the tests and the default deployment use, keeps its
-- characters across restarts and is unaffected.

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
-- chain is still the only ledger. Not dropped on startup, for the same reason
-- reward_payments is not.
--
-- payload is the immutable list of legs, written by the one INSERT that enqueues
-- a reward. Neither database adapter here exposes a transaction, so that single
-- statement is what makes authoring atomic. The rows in reward_outbox_legs are
-- derived from the payload on the first claim and deriving them again does
-- nothing, so a crash on either side of either step loses no reward and
-- duplicates none.
--
-- The character-id reuse this file warns about above applies here too, and here
-- it is blocked rather than lived with. Every table above is dropped and
-- recreated on each boot, so on this adapter startup calls the outbox's
-- quarantine and every undelivered reward stops and waits for a person, instead
-- of a stale row suppressing a new character's reward or paying an old one to
-- somebody else. See src/server/index.ts.

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