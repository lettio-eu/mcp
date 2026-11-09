import type { Brand } from "./format.js";

/**
 * The customer panel's mail brand: colours and a font from a fixed list,
 * mapped to the renderer's Brand. Font stacks go into a style attribute, so
 * they use single quotes only.
 */

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function google(family: string): string {
  return `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@400;600&display=swap`;
}

export const PANEL_FONTS: Record<
  "system" | "inter" | "lexend" | "roboto" | "open-sans" | "source-sans-3" | "georgia",
  { stack: string; url?: string }
> = {
  system: { stack: SANS },
  inter: { stack: `Inter,${SANS}`, url: google("Inter") },
  lexend: { stack: `Lexend,${SANS}`, url: google("Lexend") },
  roboto: { stack: `Roboto,${SANS}`, url: google("Roboto") },
  "open-sans": { stack: `'Open Sans',${SANS}`, url: google("Open Sans") },
  "source-sans-3": {
    stack: `'Source Sans 3',${SANS}`,
    url: google("Source Sans 3"),
  },
  georgia: { stack: "Georgia,'Times New Roman',Times,serif" },
};

export function brandFromPanel(input: {
  primaryColor: string;
  accentColor: string;
  font: keyof typeof PANEL_FONTS;
  logoUrl?: string | null;
  logoAlt?: string;
}): Brand {
  const font = PANEL_FONTS[input.font];
  return {
    primary: input.primaryColor,
    accent: input.accentColor,
    font: font.stack,
    ...(font.url ? { fontUrl: font.url } : {}),
    ...(input.logoUrl ? { logoUrl: input.logoUrl } : {}),
    ...(input.logoUrl && input.logoAlt ? { logoAlt: input.logoAlt } : {}),
  };
}
