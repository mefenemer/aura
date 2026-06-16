// src/utils/storage-keys.ts
// US-STOR-1.1.1: Tenant-scoped R2 object-key derivation and isolation guards.
//
// Every R2 object key MUST be prefixed with the owning org's id so that a pre-signed
// URL issued for one tenant can never address another tenant's objects (AC2, AC12, AC13).

/**
 * AC13: a key may only be issued for a valid, positive integer orgId.
 * Throws on null/zero/negative/non-integer so no object can be written without a tenant prefix.
 */
export function assertValidOrgId(orgId: unknown): asserts orgId is number {
    if (typeof orgId !== 'number' || !Number.isInteger(orgId) || orgId <= 0) {
        throw new Error('Invalid orgId — cannot issue key without valid tenant prefix.');
    }
}

/**
 * AC2: build a tenant-scoped object key: `{orgId}/{assetType}/{uuid}.{ext}`.
 * The uuid is injected so callers control randomness (and tests stay deterministic).
 */
export function buildTenantKey(orgId: number, assetType: string, filename: string, uuid: string): string {
    assertValidOrgId(orgId);
    if (!assetType) throw new Error('assetType required for key construction.');
    const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
    return `${orgId}/${assetType}/${uuid}.${ext}`;
}

/**
 * AC12: returns true only if the key lives under the given org's prefix.
 * Used as a defence-in-depth check before signing read/write URLs so that a key
 * belonging to org B can never be signed on behalf of a caller scoped to org A.
 */
export function keyBelongsToOrg(r2Key: string | null | undefined, orgId: number): boolean {
    if (!r2Key) return false;
    assertValidOrgId(orgId);
    return r2Key.startsWith(`${orgId}/`);
}
