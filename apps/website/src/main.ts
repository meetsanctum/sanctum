import "./styles.css";

// The waitlist answers without sending the address anywhere.
const form = document.querySelector<HTMLFormElement>("#waitlist");
const note = document.querySelector<HTMLElement>("#waitlist-note");
form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (note) {
    note.textContent =
      "Thanks. Nothing was sent: this page doesn't collect addresses.";
  }
  form.reset();
});

const scene = document.querySelector<HTMLElement>(".scene");
const backdrop = document.querySelector<HTMLImageElement>(".backdrop");
const github = document.querySelector<HTMLAnchorElement>("#github");
const stars = document.querySelector<HTMLElement>("#stars");
const starCount = document.querySelector<HTMLElement>("#star-count");
if (github && stars && starCount) {
  void showStars(github, stars, starCount);
}
if (
  scene &&
  backdrop &&
  github &&
  !matchMedia("(prefers-reduced-transparency: reduce)").matches
) {
  void frost(scene, backdrop, github);
}

// The library's frosted glass variant, in button mode for hover and press.
// The library loads only here, and starts once the photo and fonts it samples
// are in; if anything fails the button stays plain Carbon.
async function frost(
  scene: HTMLElement,
  backdrop: HTMLImageElement,
  glass: HTMLElement,
) {
  try {
    const [{ LiquidGlass }] = await Promise.all([
      import("@ybouane/liquidglass"),
      document.fonts.ready,
      loaded(backdrop),
    ]);
    glass.dataset.config = JSON.stringify({
      blurAmount: 0.25,
      cornerRadius: 30,
      button: true,
    });
    await LiquidGlass.init({ root: scene, glassElements: [glass] });
    glass.classList.add("frosted");
  } catch {
    // No WebGL, or the photo did not load: keep the plain button.
  }
}

// The load event rather than decode(), which can wait indefinitely while the
// browser isn't painting the page, such as in a background tab.
function loaded(image: HTMLImageElement): Promise<void> {
  if (image.complete) {
    return image.naturalWidth > 0
      ? Promise.resolve()
      : Promise.reject(new Error("The photo did not load"));
  }
  return new Promise((resolve, reject) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", reject, { once: true });
  });
}

// GitHub's API answers without a token for a public repository. Without an
// answer the count stays hidden.
async function showStars(
  github: HTMLAnchorElement,
  stars: HTMLElement,
  starCount: HTMLElement,
) {
  try {
    const repository = new URL(github.href).pathname.slice(1);
    const response = await fetch(`https://api.github.com/repos/${repository}`);
    if (!response.ok) return;
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || !("stargazers_count" in data)) {
      return;
    }
    const count = data.stargazers_count;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      return;
    }
    starCount.textContent = new Intl.NumberFormat("en", {
      notation: "compact",
    }).format(count);
    stars.hidden = false;
  } catch {
    // Network or response-body failures leave the optional count hidden.
  }
}
