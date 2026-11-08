# Email plugin (QQ Mail / SMTP)

## Where to configure it

**Settings page: <http://127.0.0.1:1461/dsh-email-plugin/settings>**

The port is your DSH web port (1461 on this machine). Fill in the mailbox address and the SMTP authorization code, then click Save — it takes effect immediately, no restart needed. The page also has Test connection and Send test email buttons.

## QQ Mail authorization code

1. Sign in to <https://mail.qq.com>.
2. Open **Settings → Account**.
3. Enable **IMAP/SMTP service** under POP3/IMAP/SMTP.
4. Generate the **authorization code** (shown once).

Use `smtp.qq.com:465` with `SSL/TLS`. The authorization code is the SMTP password, not your QQ login password.

## Tools

| Tool | Purpose |
| --- | --- |
| `email_send` | Send mail: plain text / HTML / CC / BCC / attachments |
| `email_verify` | Connect and authenticate without sending |
| `email_status` | Show the resolved configuration (password masked) and the settings URL |

## Configuration file

`%USERPROFILE%\.dsh\email-plugin.json` — written by the settings page; can also be edited by hand, or replaced with `DSH_EMAIL_*` environment variables. Configuration is re-read on every call.

## Security

The settings page only answers on 127.0.0.1 and requires a same-origin request for writes. The authorization code is never echoed back to the page and stays in the local JSON file; the model can call the sending tools but never sees the code.
