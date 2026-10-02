import unittest
from pathlib import Path
from unittest.mock import patch
from macos_signing import NAME, TEAM, require_timestamp, validate, verify_tree


class SigningRequirements(unittest.TestCase):
    def certificate(self, **changes):
        fields = {"sha1": "A" * 40, "issuer": "CN=Developer ID Certification Authority,OU=G2,O=Apple Inc.,C=US",
                  "subject": f"CN={NAME},OU={TEAM},UID={TEAM}",
                  "notBefore": "Jan  1 00:00:00 2026 GMT", "notAfter": "Jan  1 00:00:00 2099 GMT"}
        return fields | changes

    def test_accepts_g2_for_correct_team(self):
        validate(self.certificate())

    def test_rejects_previous_authority_with_same_subject(self):
        with self.assertRaisesRegex(RuntimeError, "OU=G2"):
            validate(self.certificate(issuer="CN=Developer ID Certification Authority,OU=Apple Certification Authority"))

    def test_g2_in_cn_is_insufficient(self):
        with self.assertRaisesRegex(RuntimeError, "OU=G2"):
            validate(self.certificate(issuer="CN=Developer ID Certification Authority G2,OU=Apple Certification Authority"))

    def test_rejects_different_team(self):
        with self.assertRaisesRegex(RuntimeError, "team"):
            validate(self.certificate(subject=f"CN={NAME},OU=OTHERTEAM"))

    def test_rejects_expired_certificate(self):
        with self.assertRaisesRegex(RuntimeError, "validity"):
            validate(self.certificate(notAfter="Jan  1 00:00:00 2020 GMT"))

    def test_file_input_also_checks_architecture(self):
        with patch.object(Path, "is_file", return_value=True), patch.object(Path, "is_dir", return_value=False), patch("macos_signing.run", side_effect=["Mach-O x86_64", "x86_64"]):
            with self.assertRaisesRegex(RuntimeError, "arm64"):
                verify_tree(Path("test-runtime"), arm64=True)

    def test_requires_secure_timestamp(self):
        with self.assertRaisesRegex(RuntimeError, "timestamp"):
            require_timestamp("Signed Time=Oct 2, 2026\n")
        require_timestamp("Timestamp=Oct 2, 2026 at 12:00:00\n")


if __name__ == "__main__":
    unittest.main()
