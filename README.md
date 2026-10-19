# Codemagic Patch

[![Discord](https://img.shields.io/discord/1131597315707261018?logo=discord&label=Discord)](https://codemagic.io/discord/) &nbsp; [![react-native-patch on npm](https://img.shields.io/npm/v/@codemagic/react-native-patch?label=react-native-patch)](https://www.npmjs.com/package/@codemagic/react-native-patch) &nbsp; [![capacitor-patch on npm](https://img.shields.io/npm/v/@codemagic/capacitor-patch?label=capacitor-patch)](https://www.npmjs.com/package/@codemagic/capacitor-patch) &nbsp; [![npm downloads](https://img.shields.io/npm/dm/@codemagic/react-native-patch)](https://www.npmjs.com/package/@codemagic/react-native-patch) &nbsp; [![GitHub Stars](https://img.shields.io/github/stars/codemagic-ci-cd/codemagic-patch)](https://github.com/codemagic-ci-cd/codemagic-patch) &nbsp; [![Follow @codemagicio](https://img.shields.io/twitter/follow/codemagicio?style=social)](https://x.com/codemagicio) &nbsp; [![LinkedIn](https://img.shields.io/badge/Follow%20on%20LinkedIn-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/company/16170400)

Codemagic Patch is a **self-hosted over-the-air (OTA) update service for React Native and Capacitor apps**. Ship JavaScript and web-asset changes straight to installed apps, with no app-store review for changes that live outside the native binary.

---

## Quickstart — try it locally

Run the whole service on your machine before you set up domains or OAuth. The **local evaluation stack** runs the real server, release worker, PostgreSQL, MinIO, and dashboard, with sign-in replaced by a one-click local login. It serves React Native and Capacitor apps alike.

You need **Docker** (with Compose v2), **Node.js `20.19+` or `22.12+`**, `git`, and `curl`, on macOS, Linux, or WSL 2.

```bash
npm install -g @codemagic/patch-cli
cmpatch selfhost local-eval
```

The command keeps its own copy of this repository, checks Docker first (and offers to install or start it), brings the stack up, and points `cmpatch` at it. The first run builds images and can take a few minutes. When it finishes, you have:

| Service           | Address                                                          |
| ----------------- | ---------------------------------------------------------------- |
| Dashboard         | <http://localhost:8080>, with a prefilled one-click local login  |
| API URL           | `http://localhost:3000`                                          |
| Download base URL | `http://localhost:9100/codemagic-patch`                          |

`cmpatch selfhost local-eval status` prints the rest: the services, the MinIO console, the seeded API token, and a sample publish command.

<details>
<summary>Start the stack from a clone instead</summary>

```bash
git clone https://github.com/codemagic-ci-cd/codemagic-patch.git
cd codemagic-patch
./scripts/local-eval/up.sh
```

The script needs Node.js `22.20+` and Yarn (via Corepack), and installs `cmpatch` globally itself. In the clone, run `cmpatch demo` from its root, and stop the stack with `cmpatch selfhost local-eval down --checkout .` (`docker compose -f docker-compose.dev.yml down -v` also stops it, but deletes the data).

</details>

### Connect your app

Configure the SDK with the API URL and download base URL above. The iOS Simulator reaches `localhost` directly. For an Android emulator or a USB-connected device, forward both ports first with `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:9100 tcp:9100`. Android also blocks plain HTTP by default, so for local evaluation the app needs `android:usesCleartextTraffic="true"` on its `<application>` element; remove it before a store build.

- **React Native:** run `cmpatch init --server-url http://localhost:3000` from your project root. It creates one app per platform and wires the SDK into your app. OTA updates apply to release builds only, because debug builds load JavaScript from Metro. See [Local quickstart › React Native](https://patch.codemagic.io/docs/?sdk=react-native#5-try-it-with-your-own-app).
- **Capacitor:** install the SDK (`@codemagic/capacitor-patch`) in your app and the CLI (`@codemagic/capacitor-patch-cli`) globally, sign in with `cmpatch-capacitor login --server-url http://localhost:3000`, and create one app per platform with `cmpatch-capacitor app create`. Then put the URLs and deployment keys in `capacitor.config.ts` and run `npx cap sync`. See [Local quickstart › Capacitor](https://patch.codemagic.io/docs/?sdk=capacitor#5-try-it-with-your-own-app).

### Watch an update apply (optional)

- **React Native:** `cmpatch demo` builds a ready-made storefront app, publishes a one-line fix after you confirm, and lets you watch the app install it over the air. It needs Node.js `22.20+`, Yarn (via Corepack), and either Xcode with an iOS Simulator or an Android SDK with a running emulator. See the [on-device demo](examples/on-device-demo/README.md).
- **Capacitor:** the [Ionic example app](client-capacitor/example-app/README.md) runs the check, download, install, and rollback cycle against the local stack from a clone of this repository.

### Stop the stack

```bash
cmpatch selfhost local-eval down                 # keeps the data for the next start
cmpatch selfhost local-eval down --delete-data   # removes the data too
```

> ⚠️ **Evaluation only, not a deployment.** Authentication is disabled and every port binds to localhost. To deploy on your own domains, see [Going to production](#going-to-production).

---

## Going to production

Install the server from your own machine. You need a host you can reach over SSH, two hostnames (one for the API and dashboard, one for artifact storage), and a GitHub, Bitbucket Cloud, or GitLab account for sign-in. The wizard asks for everything else, and offers to put Cloudflare or CloudFront in front of storage.

```bash
npm install -g @codemagic/patch-cli
cmpatch selfhost install
```

Then connect your app and publish a release:

|                   | React Native                                                                                                                                               | Capacitor                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect the app   | `cmpatch init`                                                                                                                                             | `cmpatch-capacitor app create`, then `capacitor.config.ts`                                                                                                      |
| Publish a release | `cmpatch release-react`                                                                                                                                    | `cmpatch-capacitor release create`                                                                                                                              |
| Guides            | [Native setup](https://patch.codemagic.io/docs/setup/native-setup) · [First release](https://patch.codemagic.io/docs/setup/first-release?sdk=react-native) | [Native setup](https://patch.codemagic.io/docs/setup/native-setup-capacitor) · [First release](https://patch.codemagic.io/docs/setup/first-release?sdk=capacitor) |

Start with the [Install guide](https://patch.codemagic.io/docs/install) for the server. Backups, restores, and upgrades also run from your machine, with `cmpatch selfhost backup`, `restore`, and `upgrade` (see [Operations](https://patch.codemagic.io/docs/reference/operations)).

---

## Documentation

The full documentation is at **[patch.codemagic.io/docs](https://patch.codemagic.io/docs/)**. Pages that differ between frameworks have a React Native / Capacitor switcher.

| Topic             | Pages |
| ----------------- | ----- |
| Learn             | [How it works](https://patch.codemagic.io/docs/introduction/how-it-works) · [Core concepts](https://patch.codemagic.io/docs/introduction/core-concepts) · [How delivery works](https://patch.codemagic.io/docs/using-patch/delivery) · How Patch compares: [React Native](https://patch.codemagic.io/docs/introduction/comparison) / [Capacitor](https://patch.codemagic.io/docs/introduction/comparison-capacitor) |
| Run the server    | [Install](https://patch.codemagic.io/docs/install) · [Cloudflare](https://patch.codemagic.io/docs/setup/cloudflare) · [CloudFront](https://patch.codemagic.io/docs/setup/cloudfront) · [Infrastructure](https://patch.codemagic.io/docs/setup/infrastructure) · [Ongoing maintenance](https://patch.codemagic.io/docs/setup/ongoing-maintenance) |
| Integrate the SDK | <a id="part-4--connect-your-react-native-app"></a>Native setup: [React Native](https://patch.codemagic.io/docs/setup/native-setup) / [Capacitor](https://patch.codemagic.io/docs/setup/native-setup-capacitor) · [Checking for updates](https://patch.codemagic.io/docs/setup/checking-for-updates) · [Applying updates](https://patch.codemagic.io/docs/setup/applying-updates) · [Manual control](https://patch.codemagic.io/docs/setup/manual-control) |
| Ship releases     | [Dashboard](https://patch.codemagic.io/docs/using-patch/dashboard) · [Releasing updates](https://patch.codemagic.io/docs/using-patch/releasing-updates) · [Fingerprinting](https://patch.codemagic.io/docs/using-patch/fingerprinting) (React Native) · [Binary versions](https://patch.codemagic.io/docs/using-patch/binary-version-capacitor) (Capacitor) · [Verify a test release](https://patch.codemagic.io/docs/using-patch/verify-test-release) · [Preparing for production](https://patch.codemagic.io/docs/using-patch/preparing-for-production) · [Production control](https://patch.codemagic.io/docs/using-patch/production-control) · <a id="code-signing-optional"></a>[Security and code signing](https://patch.codemagic.io/docs/using-patch/security) · [CI integration](https://patch.codemagic.io/docs/using-patch/ci-integration) |
| Operate           | [Operations](https://patch.codemagic.io/docs/reference/operations) · [Analytics](https://patch.codemagic.io/docs/using-patch/analytics) · [Troubleshooting](https://patch.codemagic.io/docs/troubleshooting) · [FAQ](https://patch.codemagic.io/docs/faq) |
| Reference         | [SDK](https://patch.codemagic.io/docs/reference/sdk-reference) · [`cmpatch` CLI](https://patch.codemagic.io/docs/reference/cli-reference) · [`cmpatch-capacitor` CLI](cli-capacitor/README.md) · [Configuration](https://patch.codemagic.io/docs/reference/configuration) · [Delivery protocol](PROTOCOL.md) |
| Migrate           | [From CodePush](https://patch.codemagic.io/docs/migration/migrating-from-codepush) · [From Expo Updates](https://patch.codemagic.io/docs/migration/migrating-from-expo-updates) · [From Appflow Live Updates](https://patch.codemagic.io/docs/migration/migrating-from-appflow) |
| Release notes     | [All components](https://patch.codemagic.io/docs/releases) |

---

## Community and feedback

Your feedback helps us improve Codemagic Patch. Tell us what works well, what has been challenging, and what you would like to see next.

- 💬 Ask questions in the [Codemagic Discord](https://codemagic.io/discord/), where our developers help out and take feature requests.
- 🗣️ Start a discussion in [GitHub Discussions](https://github.com/codemagic-ci-cd/codemagic-patch/discussions).
- 📅 Book a [feedback call](https://calendly.com/zach-codemagic/30min), or email zach@codemagic.io.
