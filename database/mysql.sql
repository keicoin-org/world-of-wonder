
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
-- balance and authorizes nothing; the chain is still the only ledger.
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