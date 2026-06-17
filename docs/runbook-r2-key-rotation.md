# Runbook: Cloudflare R2 API Key Rotation (Zero-Downtime)

**Story:** US-STOR-1.1.1 — AC8
**Scope:** Rotating the R2 read-write API token used by the storage Netlify Functions
(`storage-request-upload`, `storage-download-url`, `storage-confirm-upload`,
`storage-lifecycle-cleanup`, `purge-tombstoned-assets`).

The application reads R2 credentials exclusively from Netlify environment variables
(AC5) — never from code or committed `.env`. Because every storage function reads the
env at invocation time, swapping the env var and redeploying performs the rotation with
no code change.

## Tokens in use

| Env var | Token | Permissions (AC6) |
|---|---|---|
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Read-write app token | Object Read + Object Write on the app bucket only |
| `R2_AUDIT_ACCESS_KEY_ID` / `R2_AUDIT_SECRET_ACCESS_KEY` | Read-only audit token (AC7) | Object Read on the app bucket only |
| `R2_ENDPOINT` | `https://<accountId>.r2.cloudflarestorage.com` | — |
| `R2_BUCKET_NAME` | App bucket name | — |

> The audit token (AC7) is stored separately from the read-write token and is rotated
> with the same procedure, substituting the `R2_AUDIT_*` vars.

## Zero-downtime rotation procedure

1. **Create the new token.** Cloudflare dashboard → R2 → *Manage R2 API Tokens* →
   *Create API Token*. Scope: **Object Read & Write**, **specified bucket only**
   (the app bucket). Do **not** grant `Bucket Create`/`Bucket Delete` or account-level
   permissions (AC6). Record the new Access Key ID + Secret Access Key.

2. **Stage the new credentials in Netlify.** Site → *Site configuration* →
   *Environment variables*. Update `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` to the
   new values. (The old token is still valid at this point — both work, so there is no
   gap in availability.)

3. **Trigger a deploy** so functions pick up the new env (Netlify rebuilds the function
   bundle with the new env on deploy). Trigger via *Deploys → Trigger deploy*, or push a
   commit.

4. **Verify the new token works.** Run the tenant-isolation test against the live bucket
   (it performs a real pre-signed GET):

   ```bash
   R2_ENDPOINT=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET_NAME=… \
     npm run test:storage-isolation
   ```

   Then perform a real upload + download in the app and confirm both succeed.

5. **Revoke the old token.** Only after step 4 passes: Cloudflare dashboard → R2 API
   Tokens → select the previous token → *Revoke*. Availability is never interrupted
   because the new token was already live before the old one was revoked.

6. **Record the rotation** (date, operator, token id) in the ops log.

## Internal KEK rotation (vault secrets)

This runbook covers the **R2 provider credentials**. The application-layer envelope-encryption
key (KEK) used by `src/utils/vault.ts` is rotated separately via the SuperAdmin-only
`trigger-key-rotation` function (US-DB-1.6.1), which lazily re-wraps vault rows at the
current key version.

## Rollback

If the new token misbehaves after revoking the old one, create a fresh token (step 1) and
repeat — there is no way to un-revoke. Keeping the old token live until step 5 is what makes
rollback during the window a simple env revert + redeploy.
