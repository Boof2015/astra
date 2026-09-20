# Hardware companions

Astra Thing and future hardware use the existing HTTPS companion transport and API v2 music operations. The `hardware-v1` pairing profile adds a code comparison and desktop approval; it does not require copying a ticket, scanning a QR code, or entering a PIN.

## Discovery and setup

Use **Settings → Devices → Connect a device**, or enable **Device connections**. Hardware and Phone Remote have independent enable switches and remembered-device management. They share the HTTPS listener internally; it stays running while either feature needs it. Disabling one closes only that category's streams and rejects its pending pairing attempts. Hardware playback uses its explicitly approved `playback-control` scope, independently of the Phone Remote / Local API control switch. Existing enabled hardware pairings migrate to the independent hardware setting on first launch.

Browse `_astra-remote._tcp` with mDNS. TXT includes `companion_api=2`, `hardware_pairing=hardware-v1`, `endpoint_uuid`, `name`, `protocol_version=3`, `transport=https`, and `certificate_fingerprint`. Discovery is an untrusted locator, not approval or proof of identity. USB-network devices use this same discovery mechanism; Astra does not flash, SSH into, or identify hardware by USB vendor IDs.

Astra Thing connects over USB only. On Windows, Astra advertises separately on each non-loopback IPv4 interface so discovery reaches USB while Wi-Fi, VPN, or virtual adapters are also active. Each announcement contains only that interface's IPv4 address, with a `.local` target hostname shared by its SRV and A records. While discovery is enabled, Astra checks for interface changes every five seconds, including USB attachment, removal, and address changes. Interface failures are retried independently and logged with the `[phone-remote-discovery]` prefix. macOS continues to use the system DNS-SD service.

Before pairing, inspect the server's actual TLS certificate. Keep its SHA-256 fingerprint fixed for this attempt. A changed certificate requires a fresh attempt and a fresh code comparison. Once paired, persist and verify the approved fingerprint **before sending any credential**, including on redirects or rediscovery. Never silently replace a remembered pin with an advertised fingerprint.

## Request and code comparison

Create a fresh P-256 ephemeral key pair. POST JSON to `/v1/pairing/hardware-request`:

```json
{
  "deviceName": "Astra Thing",
  "clientLabel": "Astra Thing",
  "deviceInfo": { "modelId": "astra-thing", "softwareVersion": "0.2.1-dev" },
  "phoneEphemeralPublicKey": "base64url DER SPKI public key",
  "observedCertificateFingerprint": "actual TLS certificate SHA256",
  "requestedScopes": ["observe", "playback-control", "library-search"]
}
```

`phoneEphemeralPublicKey` retains the existing transport's field name. Omitted scopes default to those three. A subset is accepted, always including `observe`. Unknown scopes, `library-write`, and `sync` are rejected. Labels are normalized and limited to 80 characters. Optional `deviceInfo` reports presentation metadata: a lowercase model ID (1–64 letters, digits, periods or hyphens) and an optional software version (up to 80 characters). Astra selects bundled artwork for known IDs; unknown models get a generic illustration. Model metadata is self-reported and grants no permissions. The friendly name belongs to the pairing record and can be renamed without changing the model or credentials.

When supplied, normalized `deviceInfo` is also included inside the response's `hardware` object.

The response includes `requestId`, `pollToken`, `expiresAt`, `identity`, `desktopEphemeralPublicKey`, `certificateFingerprint`, `protocolVersion`, and:

```json
{
  "hardware": {
    "profile": "hardware-v1",
    "deviceName": "Astra Thing",
    "clientLabel": "Astra Thing",
    "requestedScopes": ["observe", "playback-control", "library-search"]
  }
}
```

Validate the returned profile, identity, observed fingerprint, labels, and scope list before displaying a code. Use the returned normalized labels and scope order in the transcript. Do not accept a different profile or silently broaden the requested permissions.

Both peers independently derive the code. The HTTP response does **not** supply the display code. The hardware transcript is the UTF-8 encoding of compact JSON for this ordered array:

```
[3, requestId, clientPublicKey, desktopPublicKey,
 fingerprintUppercaseHexWithoutSeparators, endpointUuidOrEmptyString,
 numericDesktopPort, "hardware-v1", normalizedDeviceName,
 normalizedClientLabel, requestedScopesArray]
```

When `hardware.deviceInfo` is present, append `[modelId, softwareVersionOrNull]` as one final array element. Omitting it preserves the original transcript byte-for-byte. Clients compare returned metadata with what they submitted before deriving the code.

Derivation matches `phoneRemoteSecurity.ts`:

- ECDH P-256 shared secret; HKDF-SHA256 with SHA256(transcript) salt, UTF-8 `astra-phone-remote-v3-pairing` info, 32-byte output.
- Code: HMAC-SHA256(key, UTF-8 `astra-phone-remote-v3-code` followed by transcript), first four bytes unsigned big-endian modulo 1,000,000, padded to six digits.
- Proof: base64url HMAC-SHA256(key, UTF-8 `astra-phone-remote-v3-proof` followed by transcript).

The user compares the hardware screen with Astra and chooses **Codes match — approve** or **Decline** in Astra. The code binds the ephemeral keys, certificate, desktop identity and port, hardware profile, client labels, and requested scopes. Do not auto-approve or compare only a code received over the network.

## Finish pairing

Poll `/v1/pairing/status?pollToken=…` about once per second. Hardware status is `pending`, `approved`, `rejected`, `expired`, or `consumed`; **it never contains credentials**. Approval alone does not create a remembered device.

After `approved`, POST `{ "requestId": "…", "proof": "…" }` to `/v1/pairing/hardware-confirm`. Proof submission before desktop approval returns 409. The legacy `/pin-confirm` cannot finish a hardware request. A successful response contains `sealed` (`nonce`, `ciphertext`, `authTag`, all base64url), `identity`, `certificateFingerprint`, and `state: "approved"`.

Decrypt with AES-256-GCM using the derived key. The additional authenticated data is UTF-8 `astra-phone-remote-v3-confirm:` followed by the raw SHA256(transcript) digest. The plaintext contains `controlToken`, `syncToken: null`, `deviceId`, `issuedAt`, `identity`, `certificateFingerprint`, and granted `scopes`. Verify the identity/pin and scope subset again before atomically saving the credential in private device storage. Delete ephemeral keys after success or failure. A success consumes the request; if the final response is lost, begin a new pairing attempt.

Requests expire after two minutes. Secure pairing allows one pending request across the phone and hardware modes. Requests are limited to one every five seconds per address; three invalid proofs reject a request and lock that address for five minutes. Rejection returns 403; expired/consumed confirmation returns 410. A device should show retry/declined/expired states rather than looping automatically through new approval prompts.

## Remembered devices and music operations

Hardware records use `clientKind: "hardware"`. They have no sync token and cannot write favorites/playlists. The legacy `control` scope supports transport sessions only; hardware cannot use the legacy v1 playback/queue routes to bypass API v2 scopes. API v2 enforces the explicit companion scopes. Existing phone and browser pairings remain compatible.

Use `/v1/session` and `/v1/session/rotate` for reconnect and credential rotation. Keep the existing certificate pin, persist rotated credentials atomically, and respect expiry/revocation responses. Astra's **Devices** section shows illustrated cards with the saved name and actual authenticated event-connection status. The detail view supports rename and confirmed **Forget**. Forget invalidates that device's credentials and closes only its streams. Phone Remote's reset and Forget All preserve hardware records. The paused category returns a retryable 503 to known control credentials while the shared listener remains available, so toggling connections does not require pairing again.

An already-paired companion may POST `{ "modelId": "astra-thing", "softwareVersion": "0.2.1-dev" }` to `/v1/session/device-info` using its control credential. This generic session endpoint updates only its own presentation metadata, without replacing its user-assigned name or scopes. Older Astra versions return 404; clients may continue without metadata support.

After authentication inspect `/v2/capabilities` and `grantedScopes`:

- Playback and queue: existing snapshots/events/actions and queue item edits.
- Search songs: `/v2/search?q=…&types=track&limit=…`.
- Playlist shelf: `/v2/playlists?limit=12`, then the returned `nextCursor`. Maximum 50 items; invalid limits/cursors return 400. `playlistListing` advertises this feature. Listing requires `library-search`.
- Playlist pages contain only signed refs, titles, artwork URLs, kind, and track count; total and next cursor support navigation. Dynamic counts are null so browsing never evaluates every dynamic playlist. Order is stable by creation ID; a deleted cursor item does not prevent continuing. Start over to refresh additions/deletions.
- Play or enqueue a returned ref through `/v2/intents`; artwork uses the existing bounded `/v2/artwork/{ref}` route. Listing exposes neither a filesystem catalog nor audio files.

The Car Thing client implements this flow, reports its model during pairing and authenticated reconnect, and uses the v2 playlist/queue/search endpoints. An old playback-only pairing does not gain new scopes automatically.
