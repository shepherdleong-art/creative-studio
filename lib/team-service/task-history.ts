/** SQL expressions accept only internal column expressions, never request input. */
export function releasedConcurrencySql(permitId: string): string {
  return `(EXISTS (SELECT 1 FROM execution_reservations history_slot
    WHERE history_slot.permitId = ${permitId} AND history_slot.kind = 'concurrency'
      AND history_slot.state = 'released')
    AND NOT EXISTS (SELECT 1 FROM execution_reservations history_slot
      WHERE history_slot.permitId = ${permitId} AND history_slot.kind = 'concurrency'
        AND history_slot.state <> 'released'))`;
}
