// Sends the approval email with the rewritten CSV attached, through Resend
// (https://resend.com). Needs RESEND_API_KEY; EMAIL_FROM sets the sender
// (a verified domain address, e.g. "Listing Ally <ally@yourbrand.com>").
// Without a key the app falls back to an email draft in the user's own client.
const MAX_RECIPIENTS = 10;
const MAX_ATTACHMENT_BYTES = 5_000_000;
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

export const emailEnabled = () => Boolean(process.env.RESEND_API_KEY);

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(s => s.trim()).filter(Boolean);

export async function sendApprovalEmail({ to, cc, subject, text, attachment }) {
  if (!emailEnabled()) return { status: 501, body: { error: 'Email sending is not configured' } };
  const toList = list(to), ccList = list(cc);
  const bad = [...toList, ...ccList].filter(e => !EMAIL_RE.test(e));
  if (!toList.length) return { status: 400, body: { error: 'Add at least one recipient' } };
  if (bad.length) return { status: 400, body: { error: `Not a valid email address: ${bad.join(', ')}` } };
  if (toList.length + ccList.length > MAX_RECIPIENTS) return { status: 400, body: { error: `At most ${MAX_RECIPIENTS} recipients` } };
  if (!subject || !text) return { status: 400, body: { error: 'Subject and message are required' } };
  const attachments = [];
  if (attachment?.content) {
    if (Buffer.byteLength(attachment.content) > MAX_ATTACHMENT_BYTES) return { status: 413, body: { error: 'Attachment is larger than 5 MB' } };
    attachments.push({
      filename: String(attachment.filename || 'listings-rewritten.csv').replace(/[^\w.-]/g, '_'),
      content: Buffer.from(attachment.content, 'utf8').toString('base64'),
    });
  }
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'Listing Compliance Ally <onboarding@resend.dev>',
        to: toList, ...(ccList.length ? { cc: ccList } : {}),
        subject: String(subject).slice(0, 200), text: String(text).slice(0, 50_000), attachments,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { status: 502, body: { error: `Couldn't reach the email service: ${err.message}` } };
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return { status: 502, body: { error: out.message || out.error || `Email service returned HTTP ${res.status}` } };
  return { status: 200, body: { id: out.id || null, to: toList, cc: ccList } };
}
