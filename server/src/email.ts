// Outgoing email via Resend (password resets only).
//
// Configuration (environment variables):
//   RESEND_API_KEY — Resend API key. Without it, no email can go out
//                    and sendPasswordResetEmail returns false (the
//                    forgot-password flow still answers with its generic
//                    message — it just can't deliver the link yet).
//   RESEND_FROM    — sender address, e.g. "Chore Champions <noreply@yourdomain.com>".
//                    Resend only delivers to arbitrary recipients from a
//                    verified domain; until a domain is verified, mail
//                    only reaches the account owner's own address.
//   RESEND_API_URL — override for tests (default https://api.resend.com/emails).
//
// The reset token is never logged and never appears in any stored
// record — only the link handed to Resend carries it, and this module
// never writes it anywhere.

const RESEND_API_URL_DEFAULT = "https://api.resend.com/emails";

/** Send a password-reset email. Returns true when Resend accepted it,
 *  false when sending is unconfigured or failed. Never throws. */
export async function sendPasswordResetEmail(args: {
  to: string;
  resetUrl: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;
  if (!apiKey || !from) {
    console.warn(
      "[email] password-reset email not sent: RESEND_API_KEY / RESEND_FROM is not set.",
    );
    return false;
  }
  const apiUrl = process.env.RESEND_API_URL ?? RESEND_API_URL_DEFAULT;
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: args.to,
        subject: "Reset your Chore Champions password",
        html: `<p>Someone asked to reset the password for this Chore Champions account.</p><p><a href="${args.resetUrl}">Reset your password</a></p><p>The link works once and expires in 1 hour. If you didn't ask for this, you can ignore this email — your password stays the same.</p>`,
        text: `Someone asked to reset the password for this Chore Champions account.\n\nReset your password (works once, expires in 1 hour): ${args.resetUrl}\n\nIf you didn't ask for this, ignore this email — your password stays the same.`,
      }),
    });
    if (!res.ok) {
      console.warn(`[email] Resend refused the reset email (${res.status}).`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[email] password-reset email failed to send.", err);
    return false;
  }
}
