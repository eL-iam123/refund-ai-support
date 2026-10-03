/**
 * Reading the shape of a customer's message, for the reply only.
 *
 * Two cases where the decision is already correct but the default wording is not:
 *
 * 1. **An attachment with no words.** "https://cdn.example.com/IMG_4021.jpg" is
 *    the single most common message in a damage-claims product, and it carries no
 *    claim at all. The resolver escalates it, correctly - there is nothing to
 *    approve. But the default escalated wording says "nothing further is needed
 *    from you", which is a promise that a person is looking at their photo. We
 *    cannot see it. Telling them to wait is how a customer spends a day waiting
 *    for a verdict on an image nobody received.
 *
 * 2. **Frustration.** "This whole process is a joke, three weeks and still
 *    nothing" escalates, correctly. Answering that with a status line about
 *    business days reads as not having been read.
 *
 * What this module deliberately does not do is decide anything. Both cases
 * escalate, and they escalate for reasons that have nothing to do with tone or
 * attachments - a bare URL is ambiguous, and an angry message is not a grounded
 * claim. This only changes how the decision is *worded*, so there is no path by
 * which feeling sympathetic moves money.
 */

const URL = /\bhttps?:\/\/\S+/gi;
const IMAGE_FILE = /\S+\.(?:jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif)\b/gi;
/** Past-tense references to a picture, which mean the words are not only a link. */
const MENTIONS_ATTACHMENT = /\b(?:photo|picture|image|screenshot|attachment|attached)\b/i;

/** Words left over once links and filenames are removed. */
function proseAfterStrippingAttachments(message: string): string {
  return message.replace(URL, ' ').replace(IMAGE_FILE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when the message is an attachment and essentially nothing else.
 *
 * Deliberately strict. A customer who writes "here is the photo, the mug is in
 * pieces" has made a claim and the normal wording is right for them. Requiring the
 * remainder to be almost empty is what keeps this from firing on a link inside an
 * otherwise ordinary complaint.
 */
export function isAttachmentOnly(message: string): boolean {
  const prose = proseAfterStrippingAttachments(message);
  if (MENTIONS_ATTACHMENT.test(message)) {
    return false;
  }
  const hasAttachment = URL.test(message) || IMAGE_FILE.test(message);
  if (!hasAttachment) {
    return false;
  }
  // Up to three words is "here you go" or "sorry about this". A fourth word is
  // most likely the start of a claim that happened to follow a link.
  return prose.split(' ').filter((word) => word.length > 0).length <= 3;
}

const FRUSTRATION = [
  /\b(?:joke|ridiculous|absurd|outrageous|appalling|unacceptable|furious|livid)\b/i,
  /\b(?:third|3rd|fourth|4th|fifth|5th)\s+(?:time|attempt|email|call|message)\b/i,
  /\b(?:weeks?|months?)\s+(?:and|since)\s+(?:still|no|nothing)\b/i,
  /\b(?:nobody|no one)\s+(?:has\s+)?(?:replied|responded|answered|contacted)\b/i,
  /\b(?:sick|tired|fed up)\s+of\b/i,
  /\b(?:worst|terrible|hopeless)\b/i,
];

/**
 * True when the customer is angry rather than merely unhappy.
 *
 * Matched on frustration patterns only, and only used to add an acknowledgement.
 * There is deliberately no sentiment score and no model call: a tone classifier
 * that can be talked into calling a customer calm is a liability in a system whose
 * whole argument is that the words do not move the decision.
 */
export function isFrustrated(message: string): boolean {
  return FRUSTRATION.some((pattern) => pattern.test(message));
}

/**
 * What to open with, if anything.
 *
 * Returned separately from the decision text so the same acknowledgement cannot
 * be applied twice or leak into a summary, a trace or a policy document.
 */
export function acknowledgementFor(message: string): string {
  if (isAttachmentOnly(message)) {
    return (
      'We cannot open image attachments yet, so we cannot see what you have sent us. ' +
      'Tell us in a few words what arrived and what is wrong with it, and we will pick it up from there.'
    );
  }
  if (isFrustrated(message)) {
    // No promise about a person here any more. An acknowledgement is also used
    // when the reply is a question, and "it is with a person" would contradict the
    // question the customer is looking at. Where a person really has it, the decision
    // text says so and says why.
    return 'That sounds like this has dragged on, and I am sorry about that.';
  }
  return '';
}
