/**
 * The reasons a shopper can pick.
 *
 * Shared by the Orders page's picker and the assistant, so the wording of a
 * complaint is written once. The two used to drift: the picker said "arrived
 * damaged" and the assistant's starter sentence said "the lamp arrived with a
 * cracked shade", and a customer who picked the first and was sent the second
 * reasonably concluded the form had not registered.
 *
 * `complaint` is the opening line the assistant drops into the composer. It is a
 * draft, not a script: the customer is expected to edit it, because "arrived
 * damaged" and "the driver threw it at me" want very different handling and only
 * the customer knows which it was.
 */
export interface Reason {
  readonly id: string;
  readonly label: string;
  readonly complaint: string;
}

export const REASONS: readonly Reason[] = [
  { id: 'damaged', label: 'Arrived damaged', complaint: 'My item arrived damaged.' },
  { id: 'wrong', label: 'Wrong item sent', complaint: 'I received the wrong item.' },
  { id: 'not-as-described', label: 'Not as described', complaint: 'The item is not as described.' },
  { id: 'late', label: 'Late delivery', complaint: 'My order arrived late.' },
  { id: 'missing', label: 'Missing from the box', complaint: 'Part of my order is missing.' },
  { id: 'duplicate', label: 'Charged twice', complaint: 'I was charged twice for this order.' },
  { id: 'return', label: 'I want to return it', complaint: 'I would like to return this item.' },
  { id: 'other', label: 'Something else', complaint: '' },
];

/** The reason matching an id from the query string, or undefined if it is not one of ours. */
export function reasonFor(id: string | null): Reason | undefined {
  return id === null ? undefined : REASONS.find((reason) => reason.id === id);
}
