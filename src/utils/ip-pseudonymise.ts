// src/utils/ip-pseudonymise.ts
// US-GDPR-3.2.2: IP address pseudonymisation for GDPR Article 32 compliance.
// IP addresses are personal data (CJEU confirmed). Audit tables must not store
// full addresses — /24 truncation retains city-level and subnet-level signal
// for abuse detection while removing individual device identifiability.

/**
 * Truncate an IP to its /24 subnet (last IPv4 octet replaced with 'x').
 * IPv6 addresses are truncated to the first 4 groups (first 64 bits).
 * Returns the pseudonymised string, or 'unknown' if the input is falsy.
 */
export function pseudonymiseIp(rawIp: string | null | undefined): string | null {
    if (!rawIp || rawIp === 'unknown') return null;

    // Strip port if present (e.g. '1.2.3.4:12345')
    const ip = rawIp.split(',')[0].trim();

    // IPv4
    const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;

    // IPv6 — keep first 4 groups (first 64 bits)
    const v6groups = ip.split(':');
    if (v6groups.length > 1) return v6groups.slice(0, 4).join(':') + ':x:x:x:x';

    // Unknown format — discard entirely rather than store raw
    return null;
}
