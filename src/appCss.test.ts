// @ts-expect-error Vitest runs in Node while the browser tsconfig omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8')

function channel(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  return (0.2126 * channel((value >> 16) & 0xff))
    + (0.7152 * channel((value >> 8) & 0xff))
    + (0.0722 * channel(value & 0xff))
}

function contrast(left: string, right: string): number {
  const [lighter, darker] = [luminance(left), luminance(right)]
    .sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('Agent panel focus tokens', () => {
  it('uses opaque focus rings with at least 3:1 contrast on light and dark surfaces', () => {
    const lightFocus = '#0b57d0'
    const darkFocus = '#8ab4f8'

    expect(css).toContain(`outline: 3px solid ${lightFocus};`)
    expect(css).toContain(`outline-color: ${darkFocus};`)
    expect(contrast(lightFocus, '#ffffff')).toBeGreaterThanOrEqual(3)
    expect(contrast(lightFocus, '#f0f2f4')).toBeGreaterThanOrEqual(3)
    expect(contrast(darkFocus, '#303134')).toBeGreaterThanOrEqual(3)
    expect(contrast(darkFocus, '#202124')).toBeGreaterThanOrEqual(3)
  })
})

describe('Agent panel narrow layout', () => {
  it('keeps the expanded panel below the Excalidraw drawing toolbar', () => {
    const narrowStart = css.indexOf('@media (max-width: 639px)')
    const narrowEnd = css.indexOf('@media (prefers-color-scheme: dark)')
    const narrowCss = css.slice(narrowStart, narrowEnd)
    const panelRules = narrowCss.match(/\.agent-panel\s*\{([^}]*)\}/)?.[1] ?? ''
    const top = Number(panelRules.match(/top:\s*(\d+)px/)?.[1])

    expect(top).toBeGreaterThanOrEqual(68)
  })
})
