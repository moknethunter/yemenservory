#!/usr/bin/env python3
"""Issue device-bound Yemen Surveyor licenses from the owner's computer."""

import argparse
import base64
from contextlib import closing
from email.message import EmailMessage
import json
import os
from pathlib import Path
import re
import smtplib
import sqlite3
import ssl
import subprocess
import sys
import time

DAY = 24 * 60 * 60
OWNER_DIR = Path.home() / ".yemen-surveyor-licensing"
EMAIL = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
DEVICE = re.compile(r"[0-9a-f]{64}")


def openssl(*arguments, payload=None):
    return subprocess.run(
        ["openssl", *arguments], input=payload, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True,
    ).stdout


def keys(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_key = directory / "signing.pem"
    try:
        descriptor = os.open(private_key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ValueError("A signing key already exists. Use public-key to read the public key.")
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256"))
    except BaseException:
        private_key.unlink(missing_ok=True)
        raise


def public_key(directory):
    public = openssl("pkey", "-in", str(directory / "signing.pem"), "-pubout", "-outform", "DER")
    return base64.b64encode(public).decode()


def token_part(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def signed_license(directory, email, device, plan, now, expires):
    claim = {
        "v": 1, "app": "yemen-surveyor", "email": email, "device": device,
        "plan": plan, "issued": now, "exp": expires,
    }
    payload = json.dumps(claim, separators=(",", ":")).encode()
    signature = openssl("dgst", "-sha256", "-sign", str(directory / "signing.pem"), payload=payload)
    return token_part(payload) + "." + token_part(signature)


def issue(directory, email, device, paid_days=None):
    email = email.strip().lower()
    device = device.strip().lower()
    if len(email) > 254 or not EMAIL.fullmatch(email) or not DEVICE.fullmatch(device):
        raise ValueError("Enter the customer's email and the 64-character device code from the app.")
    if not (directory / "signing.pem").is_file():
        raise ValueError("Run init on the owner's computer first.")
    if paid_days is not None and not 1 <= paid_days <= 3660:
        raise ValueError("Enter between 1 and 3,660 paid days.")

    db = directory / "licenses.sqlite3"
    descriptor = os.open(db, os.O_WRONLY | os.O_CREAT, 0o600)
    os.close(descriptor)
    with closing(sqlite3.connect(db, timeout=15)) as connection, connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS trials (
                email TEXT PRIMARY KEY,
                device TEXT NOT NULL UNIQUE
            );
            CREATE TABLE IF NOT EXISTS licenses (
                email TEXT NOT NULL,
                device TEXT NOT NULL,
                expires INTEGER NOT NULL,
                plan TEXT NOT NULL,
                token TEXT NOT NULL,
                PRIMARY KEY (email, device)
            );
        """)
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT expires, plan, token FROM licenses WHERE email = ? AND device = ?",
            (email, device),
        ).fetchone()
        now = int(time.time())
        if paid_days is None:
            if current:
                if current[0] > now:
                    return current[2], current[0], current[1]
                raise ValueError("The original activation has expired. Choose a paid extension.")
            try:
                connection.execute("INSERT INTO trials VALUES (?, ?)", (email, device))
            except sqlite3.IntegrityError:
                raise ValueError("This email or device has already used the free trial.")
            plan = "trial"
            expires = now + 30 * DAY
        else:
            plan = "paid"
            expires = max(now, current[0] if current else 0) + paid_days * DAY
        token = signed_license(directory, email, device, plan, now, expires)
        connection.execute(
            "INSERT OR REPLACE INTO licenses VALUES (?, ?, ?, ?, ?)",
            (email, device, expires, plan, token),
        )
        return token, expires, plan


def existing(directory, email, device):
    db = directory / "licenses.sqlite3"
    if not db.is_file():
        raise ValueError("There are no issued licenses.")
    with closing(sqlite3.connect(db)) as connection:
        row = connection.execute(
            "SELECT token, expires, plan FROM licenses WHERE email = ? AND device = ?",
            (email.strip().lower(), device.strip().lower()),
        ).fetchone()
    if not row:
        raise ValueError("No license was found for this email and device.")
    return row


def email_license(customer, token, expires, plan):
    host = os.environ["SURVEY_SMTP_HOST"]
    sender = os.environ["SURVEY_SMTP_FROM"]
    msg = EmailMessage()
    msg["From"], msg["To"] = sender, customer
    msg["Subject"] = "تفعيل مسّاح اليمن"
    expiry = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(expires))
    format_name = "تجربة مجانية" if plan == "trial" else "ترخيص مدفوع"
    msg.set_content(
        f"الترخيص: {format_name}\nالصلاحية حتى {expiry}\n"
        f"أدخل هذا البريد والرمز التالي في شاشة تفعيل مسّاح اليمن:\n\n{token}\n"
    )
    with smtplib.SMTP_SSL(host, int(os.environ.get("SURVEY_SMTP_PORT", "465")),
                          context=ssl.create_default_context(), timeout=20) as smtp:
        smtp.login(os.environ["SURVEY_SMTP_USER"], os.environ["SURVEY_SMTP_PASSWORD"])
        smtp.send_message(msg)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=OWNER_DIR)
    actions = parser.add_subparsers(dest="command", required=True)
    actions.add_parser("init")
    actions.add_parser("public-key")
    for command in ("issue", "resend"):
        action = actions.add_parser(command)
        action.add_argument("--email", required=True)
        action.add_argument("--device", required=True)
        action.add_argument("--send", action="store_true", help="Email the code to the supplied address via SMTP.")
        if command == "issue":
            plan = action.add_mutually_exclusive_group(required=True)
            plan.add_argument("--trial", action="store_true")
            plan.add_argument("--paid-days", type=int)
    args = parser.parse_args()
    try:
        if args.command == "init":
            keys(args.directory)
            print(public_key(args.directory))
        elif args.command == "public-key":
            print(public_key(args.directory))
        else:
            if args.command == "resend":
                token, expires, plan = existing(args.directory, args.email, args.device)
            else:
                token, expires, plan = issue(args.directory, args.email, args.device, args.paid_days)
            if args.send:
                email_license(args.email.strip().lower(), token, expires, plan)
                print("Activation email sent.")
            else:
                print(token)
    except (ValueError, OSError, KeyError, sqlite3.Error, smtplib.SMTPException, subprocess.CalledProcessError) as error:
        print(f"Activation error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
