CREATE TABLE IF NOT EXISTS "users" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL UNIQUE,
    "password" TEXT, 
    "token" TEXT
);
        
CREATE TABLE IF NOT EXISTS "characters" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER,
    "name" TEXT,
    "race" TEXT,
    "material" INTEGER DEFAULT 0,
    "head" TEXT,
    "location" TEXT,
    "level" int,
    "experience" int,
    "health" int,
    "mana" int,
    "x" REAL DEFAULT 0.0,
    "y"	REAL DEFAULT 0.0,
    "z"	REAL DEFAULT 0.0, 
    "rot" REAL DEFAULT 0.0,
    "gold" INTEGER DEFAULT 0,
    "strength" INTEGER DEFAULT 0,
    "endurance" INTEGER DEFAULT 0,
    "agility" INTEGER DEFAULT 0,
    "intelligence" INTEGER DEFAULT 0,
    "wisdom" INTEGER DEFAULT 0,
    "points" INTEGER DEFAULT 0,
    "online" INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "character_inventory" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "owner_id" INTEGER,
    "order" INTEGER,
    "qty" INTEGER,
    "key" TEXT
);

CREATE TABLE IF NOT EXISTS "character_hotbar" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "owner_id" INTEGER,
    "type" TEXT,
    "key" TEXT,
    "digit" INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS "character_abilities" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "owner_id" INTEGER,
    "key" TEXT
); 

CREATE TABLE IF NOT EXISTS "character_equipment" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "owner_id" INTEGER,
    "slot" INTEGER,
    "key" TEXT
);

CREATE TABLE IF NOT EXISTS "character_quests" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "owner_id" INTEGER,
    "key" TEXT,
    "status" INTEGER DEFAULT 0,
    "qty" INTEGER DEFAULT 0,
    UNIQUE("id")
);

CREATE TABLE IF NOT EXISTS "starting_purses" (
    "address" TEXT PRIMARY KEY,
    "owner_id" INTEGER,
    "amount" INTEGER DEFAULT 0,
    "granted_at" INTEGER
);

CREATE TABLE IF NOT EXISTS "reward_payments" (
    "id" TEXT PRIMARY KEY,
    "owner_id" INTEGER,
    "address" TEXT,
    "gold" INTEGER DEFAULT 0,
    "items" TEXT,
    "paid_at" INTEGER
);

-- Rewards the server has authored and the chain has not finished taking.
-- src/server/kei/Outbox.ts is the state machine; this is only where it lives.
-- Neither of these two tables holds a balance and neither authorizes anything:
-- they are workflow state and chain receipts, and the chain is still the ledger.
--
-- payload is the immutable list of legs, written by the one INSERT that enqueues
-- a reward. Neither database adapter here exposes a transaction, so that single
-- statement is what makes authoring atomic: the rows in reward_outbox_legs are
-- derived from the payload on the first claim, and deriving them again does
-- nothing. A crash on either side of either step loses no reward and duplicates
-- none.
--
-- replayable says whether ordinary play could author this same id a second time.
-- A quest can, because its id is a character and a quest key. Loot cannot,
-- because its id is an entity that died with the room. Retention reads it.

CREATE TABLE IF NOT EXISTS "reward_outbox" (
    "id" TEXT PRIMARY KEY,
    "owner_id" INTEGER,
    "address" TEXT,
    "issuer" TEXT,
    "payload" TEXT,
    "replayable" INTEGER DEFAULT 0,
    "state" TEXT DEFAULT 'pending',
    "attempts" INTEGER DEFAULT 0,
    "lease_until" INTEGER DEFAULT 0,
    "reason" TEXT,
    "enqueued_at" INTEGER,
    "settled_at" INTEGER
);

-- One asset moving to one address. units is raw units as a decimal string,
-- because a JS number cannot carry raw units of anything with decimals and a
-- reward is a bad place to lose the bottom of a number. previous is the issuer
-- frontier the mint was aimed at, recorded before it was sent: an account chain
-- is linear and single-writer, so exactly one block can ever follow a given one,
-- which is what lets an ambiguous timeout be reconciled by block identity rather
-- than by reading a balance players are free to change themselves.

CREATE TABLE IF NOT EXISTS "reward_outbox_legs" (
    "reward_id" TEXT NOT NULL,
    "leg" INTEGER NOT NULL,
    "kind" TEXT,
    "key" TEXT,
    "units" TEXT,
    "state" TEXT DEFAULT 'pending',
    "attempts" INTEGER DEFAULT 0,
    "previous" TEXT,
    "receipt" TEXT,
    "error" TEXT,
    PRIMARY KEY ("reward_id", "leg")
);