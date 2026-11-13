import appWindow from "@meetsanctum/brand/app-home-window.webp";
import heroPhoto from "@meetsanctum/brand/photos/living-room-plant.jpg";

import { productName } from "../../../client/src/brand";
import { repositoryUrl, siteUrl, xUrl } from "../site";
import { CopyPrompt } from "./copy-prompt";
import { Knot } from "./knot";
import { WaitlistForm } from "./waitlist-form";

const installGuide = `${repositoryUrl}/blob/main/docs/install.md`;

export default async function Page() {
  const stars = await starCount();
  return (
    <div className="page" id="top">
      <header className="bar">
        <a className="logo" href="/">
          <Knot size={28} />
          <span>{productName}</span>
        </a>
        <nav className="elsewhere" aria-label={`${productName} elsewhere`}>
          <a
            className="chip github"
            href={repositoryUrl}
            aria-label={`${productName} on GitHub`}
          >
            <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
              />
            </svg>
            <span className="word">GitHub</span>
            {stars && (
              <span className="stars">
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  aria-hidden="true"
                >
                  <path d="M12 4.5l2.3 4.7 5.2.8-3.75 3.65.9 5.15L12 16.4l-4.65 2.4.9-5.15L4.5 10l5.2-.8z" />
                </svg>
                <span>{stars}</span>
                <span className="visually-hidden">stars</span>
              </span>
            )}
          </a>
          <a className="chip" href={xUrl} aria-label={`${productName} on X`}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
              />
            </svg>
          </a>
        </nav>
      </header>

      <main>
        {/* The hero runs up under the top bar, to the page's top edge. */}
        <section className="hero" aria-labelledby="tagline">
          <img className="backdrop" src={heroPhoto.src} alt="" />
          <div className="veil" />

          <div className="pitch">
            <h1 id="tagline">Smart home for everyone</h1>
            <p className="description">
              {productName}'s goal is to make it super easy and intuitive to
              make your home smart. It runs your lights, sensors and
              automations.
            </p>
            <p className="stage">
              {productName} is in pre-alpha. Join the waitlist or{" "}
              <a href={xUrl}>follow on X</a> for updates on the project.
            </p>
            <WaitlistForm />
          </div>

          <div className="shot">
            <img
              src={appWindow.src}
              width={appWindow.width}
              height={appWindow.height}
              alt={`The ${productName} Mac app: the Home dashboard with each room's moods, lights and sensor readings`}
            />
          </div>

          <ul className="points">
            <li>
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M12 20h.01" />
                <path d="M8.5 16.429a5 5 0 0 1 7 0" />
                <path d="M5 12.859a10 10 0 0 1 5.17-2.69" />
                <path d="M19 12.859a10 10 0 0 0-2.007-1.523" />
                <path d="M2 8.82a15 15 0 0 1 4.177-2.643" />
                <path d="M22 8.82a15 15 0 0 0-11.288-3.764" />
                <path d="m2 2 20 20" />
              </svg>
              <span>No internet needed</span>
            </li>
            <li>
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
                <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span>Data stays local</span>
            </li>
            <li>
              <svg
                viewBox="0 0 24 24"
                width="22"
                height="22"
                aria-hidden="true"
              >
                <path d="m16 18 6-6-6-6" />
                <path d="m8 6-6 6 6 6" />
              </svg>
              <span>Free &amp; open source</span>
            </li>
          </ul>
        </section>

        <section
          className="install"
          id="install"
          aria-labelledby="install-title"
        >
          <h2 id="install-title">How to install</h2>
          <p className="lead">
            Setting up {productName} still takes a few technical steps. Here is
            what you need, and two ways to get it running.
          </p>

          <div className="parts">
            <div>
              <h3>What you need</h3>
              <ul className="needs">
                <li>
                  <span className="tile works">
                    <svg
                      viewBox="0 0 24 24"
                      width="22"
                      height="22"
                      aria-hidden="true"
                    >
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" rx="1" />
                      <path d="M15 2v2" />
                      <path d="M15 20v2" />
                      <path d="M2 15h2" />
                      <path d="M2 9h2" />
                      <path d="M20 15h2" />
                      <path d="M20 9h2" />
                      <path d="M9 2v2" />
                      <path d="M9 20v2" />
                    </svg>
                  </span>
                  <span className="what">
                    <strong>A small computer that stays on</strong>
                    <span>
                      {productName} runs on a Raspberry Pi with at least 2 GB of
                      memory, or another machine with Raspberry Pi OS, Debian or
                      Ubuntu
                    </span>
                  </span>
                </li>
                <li>
                  <span className="tile works">
                    <svg
                      viewBox="0 0 24 24"
                      width="22"
                      height="22"
                      aria-hidden="true"
                    >
                      <circle cx="10" cy="7" r="1" />
                      <circle cx="4" cy="20" r="1" />
                      <path d="M4.7 19.3 19 5" />
                      <path d="m21 3-3 1 2 2Z" />
                      <path d="M9.26 7.68 5 12l2 5" />
                      <path d="m10 14 5 2 3.5-3.5" />
                      <path d="m18 12 1-1 1 1-1 1Z" />
                    </svg>
                  </span>
                  <span className="what">
                    <strong>A Zigbee USB stick</strong>
                    <span>
                      We currently recommend: Nabu Casa ZBT-2 or ConBee III
                    </span>
                  </span>
                </li>
                <li>
                  <span className="tile works">
                    <svg
                      viewBox="0 0 24 24"
                      width="22"
                      height="22"
                      aria-hidden="true"
                    >
                      <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />
                    </svg>
                  </span>
                  <span className="what">
                    <strong>A Mac</strong>
                    <span>
                      The {productName} app runs on Macs with Apple silicon
                    </span>
                  </span>
                </li>
              </ul>
              <h4>Coming soon</h4>
              <ul className="soon">
                <li>
                  <span className="tile">
                    <svg
                      viewBox="0 0 24 24"
                      width="22"
                      height="22"
                      aria-hidden="true"
                    >
                      <rect x="3" y="8" width="10" height="14" rx="2" />
                      <path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4" />
                      <path d="M8 18h.01" />
                    </svg>
                  </span>
                  <strong>iOS and Android</strong>
                </li>
                <li>
                  <span className="tile">
                    <svg
                      viewBox="0 0 24 24"
                      width="22"
                      height="22"
                      aria-hidden="true"
                    >
                      <rect x="2" y="3" width="20" height="14" rx="2" />
                      <path d="M8 21h8" />
                      <path d="M12 17v4" />
                    </svg>
                  </span>
                  <strong>Windows</strong>
                </li>
              </ul>
            </div>

            <div className="card">
              <h3>Set it up with your AI agent</h3>
              <p>
                The easiest way for now. An AI agent that can run commands on
                your computer can guide you through the setup and do most of the
                typing. A few steps stay with you, like writing the memory card
                and plugging things in. Give it this:
              </p>
              <CopyPrompt>
                Read {siteUrl}/install.md and guide me through setting up{" "}
                {productName}.
              </CopyPrompt>
              <p className="aside">
                That page tells the agent each step, what to check first and
                what to ask you. <a href="/install.md">Open install.md</a> to
                read it yourself first.
              </p>
            </div>

            <details className="card">
              <summary>Or do it yourself, step by step</summary>
              <ol className="steps">
                <li>
                  <span className="count">Step 1</span>
                  <h4>Get the Raspberry Pi ready</h4>
                  <p>
                    On your Mac, open the free Raspberry Pi Imager and choose
                    Raspberry Pi OS Lite (64-bit). In its settings, name the Pi
                    sanctum, set a username and a password, add your Wi-Fi if
                    the Pi has no network cable, and turn on SSH. Write the
                    card, put it in the Pi and plug the Pi in. Its first start
                    takes a few minutes.
                  </p>
                </li>
                <li>
                  <span className="count">Step 2</span>
                  <h4>Connect to the Pi</h4>
                  <p>
                    Open Terminal on your Mac and type this, with the username
                    you chose in place of “you”:
                  </p>
                  <pre>
                    <code>ssh you@sanctum.local</code>
                  </pre>
                </li>
                <li>
                  <span className="count">Step 3</span>
                  <h4>Install {productName}</h4>
                  <p>
                    Paste this line and press Return. It downloads {productName}{" "}
                    and starts it, which takes a few minutes, and ends with “
                    {productName} is running”.
                  </p>
                  <pre>
                    <code>
                      curl -fsSL
                      https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh
                      | sudo bash
                    </code>
                  </pre>
                </li>
                <li>
                  <span className="count">Step 4</span>
                  <h4>Plug in the Zigbee stick</h4>
                  <p>
                    Plug one stick into the Pi. It starts working by itself
                    within a minute.
                  </p>
                </li>
                <li>
                  <span className="count">Step 5</span>
                  <h4>Build the Mac app</h4>
                  <p>
                    The app has no download for now, so your Mac builds it. It
                    needs Git, Node.js 24 and pnpm 10. In a new Terminal window
                    on the Mac:
                  </p>
                  <pre>
                    <code>{buildTheApp}</code>
                  </pre>
                  <p>
                    A folder opens with a disk image in it. Open the image and
                    drag {productName} into Applications.
                  </p>
                </li>
                <li>
                  <span className="count">Step 6</span>
                  <h4>Set up your home</h4>
                  <p>
                    Open {productName} and let it find devices on your network
                    when your Mac asks. It lists your new home: choose Set up,
                    enter your name, a username and a password, and add your
                    first light.
                  </p>
                </li>
              </ol>
              <a className="outline" href={installGuide}>
                Read the full guide
              </a>
            </details>

            <div>
              <h3>Easier ways are on the way</h3>
              <p className="closing">
                Getting {productName} running is still a little complicated. A
                simpler setup is being worked on.{" "}
                <a href="#waitlist">Join the waitlist</a> and you'll hear when
                it is ready.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer>
        <span>© 2026 {productName}</span>
        <span className="made">
          Made with
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            role="img"
            aria-label="love"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          in Zurich, Switzerland
        </span>
        <a href={repositoryUrl}>Source on GitHub</a>
      </footer>

      {/* The logo once more, very large, its foot cut off by the page's end. */}
      <div className="closing-logo" aria-hidden="true">
        <div>
          <Knot />
          <span>{productName}</span>
        </div>
      </div>
    </div>
  );
}

const buildTheApp = `git clone ${repositoryUrl}.git
cd sanctum
git checkout "$(git describe --tags --abbrev=0 origin/main)"
pnpm install
pnpm --filter @meetsanctum/desktop package
open apps/desktop/release`;

// How many stars the repository has, asked of GitHub at most once an hour;
// its API answers without a token for a public repository. Without an
// answer, or with no stars to count, the page shows none.
async function starCount(): Promise<string | null> {
  try {
    const repository = new URL(repositoryUrl).pathname.slice(1);
    const response = await fetch(`https://api.github.com/repos/${repository}`, {
      next: { revalidate: 3600 },
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("stargazers_count" in data)) {
      return null;
    }
    const count = data.stargazers_count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
      return null;
    return new Intl.NumberFormat("en", { notation: "compact" }).format(count);
  } catch {
    return null;
  }
}
