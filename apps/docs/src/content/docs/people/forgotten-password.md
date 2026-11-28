---
title: If you forget your password
description: Choose a new password on a Mac that's still signed in as you, with your recovery code, or with a code someone at home makes for you.
sidebar:
  order: 2
---

Forgetting your password doesn't sign you out anywhere. Try these in order.

## On a Mac signed in as you

If the Sanctum Mac app on one of your Macs is still signed in as you, choose
a new password there. You don't need the old one.

1. Open your own page: choose your picture at the bottom of the sidebar,
   then **Profile**.
2. Under **Sign-In**, choose **Change password**.
3. Choose **Forgot your password?**, under **Current password**.
4. Enter your new password, and choose **Change password**.

The new password never leaves your Mac. Your other devices stay signed in.
Activity shows that you chose a new password without the old one, so others
at home can see it happened.

## With your recovery code

If you saved a recovery code, use it on any Mac:

1. Open Sanctum and choose your home, then **Just me**.
2. Under **Password**, choose **Forgot your password?**.
3. Enter your recovery code.
4. Your username is filled in. Enter a new password, and choose
   **Sign in**.

The code works once. Make a new one on your page afterwards; see
[Your recovery code](/people/#your-recovery-code).

Restoring a backup invalidates saved recovery codes. Make a new one after
you sign in again.

## With a code from someone at home

If no device is signed in as you, someone else at home can make you a code
for a new password. They open your page in **Settings → People** and choose
**Reset password**, on their own Mac or on one of the home's shared devices.
Then, in the Mac app, choose your home, **Just me**, then **Forgot your
password?**, and enter the code. See
[Reset a password](/people/#reset-a-password).

## On Sanctum itself

If no device is signed in as you, you have no recovery code and no one else
at home signs in, make a code on the host, the computer running Sanctum. You
need to run commands there, as you did to install it.

1. On a computer on your home's network, open a terminal and connect to the
   host:

   ```bash
   ssh you@sanctum.local
   ```

2. Make the code. Sanctum lists who signs in and asks which:

   ```bash
   sudo docker exec -it sanctum-core node dist/cli.js reset-code
   ```

   To skip the account selection, add your username to the command.

   ```bash
   sudo docker exec sanctum-core node dist/cli.js reset-code YOUR_USERNAME
   ```

   If a password code is already active, Sanctum asks before making a new
   one, which ends the previous code. With your username in the command, add
   `--replace` after it instead.

3. On your Mac, open Sanctum and choose your home, then **Just me** and
   **Forgot your password?**, and enter the code. Choose a new password.

The code works once, for an hour, and Activity shows that Sanctum made it.
You choose your password on your Mac, and the host never sees it.
