# dsh-email-plugin

Email sending for DeepSeek Harness: three native tools (`email_send`, `email_verify`, `email_status`) plus a browser settings page.

**Settings page: <http://127.0.0.1:1461/dsh-email-plugin/settings>** (use your own DSH web port).

- Zero dependencies: the SMTP client and MIME builder are plain Node modules, so the bundle installs offline and runs no install scripts.
- Credentials live in `%USERPROFILE%\.dsh\email-plugin.json` (or `DSH_EMAIL_*` env vars) and are re-read on every call; the model never receives the password.
- Settings page is loopback-only and requires same-origin writes; the authorization code is never echoed back.

See [README.zh.md](README.zh.md) for the full Chinese guide, QQ Mail setup, and development notes.
