"""Generate disposable localhost TLS assets for proxy conformance tests."""
import argparse
from datetime import datetime, timedelta, timezone
import ipaddress
from pathlib import Path
import shlex

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

SYNTHETIC_SECRET = "external-sandbox-synthetic-secret-not-a-real-key"
PLACEHOLDER = "Bearer external-sandbox-public-placeholder"


def generate(directory):
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    names = ("cert.pem", "key.pem", "server-env.sh")
    if any((directory / name).exists() or (directory / name).is_symlink() for name in names):
        raise ValueError("Fixture files already exist; choose a new directory")
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Execution conformance localhost fixture")])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=7))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .sign(key, hashes.SHA256()))
    (directory / "cert.pem").write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    # Create private fixture keys with restrictive permissions from the outset.
    import os
    fd = os.open(directory / "key.pem", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    cert = shlex.quote(str(directory / "cert.pem"))
    (directory / "server-env.sh").write_text(
        "# Source only in the shell launching a disposable conformance target.\n"
        f"export EXTERNAL_SANDBOX_SPEC_SECRET={shlex.quote(SYNTHETIC_SECRET)}\n"
        f"export SSL_CERT_FILE={cert}\nexport NODE_EXTRA_CA_CERTS={cert}\n")
    return directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", help="New directory for disposable certificate, key, and server environment")
    args = parser.parse_args()
    try:
        directory = generate(args.directory)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Fixture written to {directory}; trust cert.pem only in the dedicated target process.")
