"""
Widevine L3 key extraction helper for blob-video-downloader.
Uses pywidevine to perform the license exchange and extract content keys.

Usage:
  python drm-keygen.py --pssh <base64> --license-url <url> \
    --client-id <path> --private-key <path> --headers <json>

Output: JSON array of { kid, key, type } objects on stdout.
"""

import argparse
import json
import sys

def main():
    parser = argparse.ArgumentParser(description='Widevine L3 key extractor')
    parser.add_argument('--pssh', required=True, help='Base64-encoded PSSH')
    parser.add_argument('--license-url', required=True, help='License server URL')
    parser.add_argument('--client-id', required=True, help='Path to device_client_id_blob')
    parser.add_argument('--private-key', required=True, help='Path to device_private_key')
    parser.add_argument('--headers', default='{}', help='JSON object of HTTP headers')
    args = parser.parse_args()

    try:
        from pywidevine.cdm import Cdm
        from pywidevine.device import Device
        from pywidevine.pssh import PSSH
    except ImportError:
        print('Error: pywidevine not installed. Run: pip install pywidevine', file=sys.stderr)
        sys.exit(1)

    try:
        import requests
    except ImportError:
        print('Error: requests not installed. Run: pip install requests', file=sys.stderr)
        sys.exit(1)

    headers = json.loads(args.headers)

    # Load device from raw client_id_blob + private_key files
    device = Device(
        client_id=open(args.client_id, 'rb').read(),
        private_key=open(args.private_key, 'rb').read(),
        type_=Device.Types.ANDROID,
        security_level=3,
    )

    cdm = Cdm.from_device(device)
    session_id = cdm.open()

    try:
        pssh = PSSH(args.pssh)
        challenge = cdm.get_license_challenge(session_id, pssh)

        # Send challenge to license server
        resp = requests.post(
            args.license_url,
            data=challenge,
            headers=headers,
            timeout=30,
        )
        resp.raise_for_status()

        cdm.parse_license(session_id, resp.content)

        keys = []
        for key in cdm.get_keys(session_id):
            keys.append({
                'kid': key.kid.hex,
                'key': key.key.hex(),
                'type': key.type,
            })

        print(json.dumps(keys))

    finally:
        cdm.close(session_id)


if __name__ == '__main__':
    main()
