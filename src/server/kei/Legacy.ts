/**
 * The database's old economy, held at arm's length.
 *
 * Upstream kept a character's belongings in `character_inventory`,
 * `character_equipment`, and a `gold` column, and the room loaded all three into
 * play. This fork moved the shop, the bag, and the auction house onto the chain
 * but left those tables loading — so a character had two inventories and two
 * balances, one of which the developer could edit with `sqlite3` (issue #6).
 *
 * This file is the boundary. The rows are read, counted, and then kept out of
 * the room: what a character joins with is nothing, because nothing in a table
 * this server owns is evidence of ownership. They are not deleted and not
 * minted — deleting would throw away the only record of what a development
 * database once contained, and minting would turn a row anybody with file access
 * could write into a valuable asset, which the issue rules out until a character
 * is cryptographically bound to an address.
 *
 * So they stay exactly as they are, unread by gameplay, waiting for a migration
 * that can prove who to give them to. `PlayerSchema.save()` is what makes that
 * true in the other direction: it no longer writes these tables, so a session
 * cannot quietly empty them.
 */

export interface LegacyItem {
  key: string
  qty: number
}

export interface LegacyEquipment {
  key: string
  slot: number
}

/** What the database still claims a character owns, and gameplay no longer sees. */
export interface LegacyRecord {
  gold: number
  items: readonly LegacyItem[]
  equipment: readonly LegacyEquipment[]
}

export const EMPTY_LEGACY: LegacyRecord = { gold: 0, items: [], equipment: [] }

/**
 * Split a database character into the part a room may load and the part it may
 * not.
 *
 * Abilities, hotbar, quests, position, level, and stat points are not here on
 * purpose: they are ordinary MMO state and stay database-backed (SPEC §8). Only
 * value and ownership are the chain's.
 */
export function quarantineLegacy(character: any): LegacyRecord {
  const rows: any[] = Array.isArray(character?.inventory) ? character.inventory : []
  const worn: any[] = Array.isArray(character?.equipment) ? character.equipment : []

  return {
    gold: Number(character?.gold ?? 0) || 0,
    items: rows
      .filter((row) => typeof row?.key === 'string' && row.key !== '')
      .map((row) => ({ key: row.key as string, qty: Number(row.qty ?? 0) || 0 })),
    equipment: worn
      .filter((row) => typeof row?.key === 'string' && row.key !== '')
      .map((row) => ({ key: row.key as string, slot: Number(row.slot ?? 0) || 0 })),
  }
}

export function isEmptyLegacy(record: LegacyRecord): boolean {
  return record.gold === 0 && record.items.length === 0 && record.equipment.length === 0
}

/**
 * What to tell a player whose character still has rows in the old tables.
 *
 * Said once, on join, and said plainly: the numbers are real rows and they are
 * really not theirs. A player who is told nothing would reasonably conclude the
 * server had eaten their starter potions.
 */
export function describeLegacy(record: LegacyRecord): string {
  const parts: string[] = []
  if (record.items.length > 0) {
    const units = record.items.reduce((total, item) => total + item.qty, 0)
    parts.push(`${units} item${units === 1 ? '' : 's'}`)
  }
  if (record.equipment.length > 0) {
    parts.push(`${record.equipment.length} piece${record.equipment.length === 1 ? '' : 's'} of equipment`)
  }
  if (record.gold > 0) {
    parts.push(`${record.gold} gold`)
  }

  return (
    `This character has ${parts.join(', ')} left in the old database tables. ` +
    'They are kept as a record and cannot be used, worn, sold, or spent: gold and items live on the chain here, ' +
    'and nothing in a table this server can edit is proof that you own anything.'
  )
}
