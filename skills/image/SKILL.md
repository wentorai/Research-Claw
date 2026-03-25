---
name: image
description: Image processing workflow guide for format selection, resizing, cropping, compression, metadata, transparency, color profiles, and destination-specific exports. Covers web, social, ecommerce, photography, branding, screenshots, and accessibility.
tags: [image, optimization, web, social, ecommerce, photography]
version: 1.0.0
author: ivangdavila
source: https://clawhub.ai/ivangdavila/image
---

# Image

Image processing workflow guide for destination-specific exports.

---

## When to Use

Use when the main artifact is an image file or visual asset, especially when:
- Format choice matters
- Resizing, cropping, compression needed
- Metadata, transparency, color profile concerns
- Destination-specific requirements (web, social, ecommerce, print)

---

## Quick Reference

| Situation | Load File | Why |
|-----------|-----------|-----|
| Web optimization, responsive images, lazy loading, SVG | web.md | Avoid CLS/LCP mistakes, oversized assets |
| Color profiles, metadata, RAW, print workflows | photography.md | Protect color intent, print readiness |
| Social platform dimensions, safe zones, banners | social.md | Prevent unsafe crops, recompression surprises |
| Product photos, marketplace standards | ecommerce.md | Preserve zoom detail, white-background compliance |
| Logos, favicons, SVGs, app icons | branding.md | Protect small-size legibility, SVG consistency |
| UI screenshots, docs captures, redaction | screenshots.md | Avoid blurry captures, privacy leaks |
| Alt text, text-in-image risk, charts | accessibility.md | Keep images usable and compliant |
| ImageMagick and Pillow commands | commands.md | Use concrete commands once decision is clear |

---

## Fast Workflow

1. **Identify asset type:** photo, screenshot, UI capture, logo, diagram, social card, product image, print source
2. **Identify destination:** web page, social upload, marketplace gallery, print handoff, internal archive
3. **Decide preservation:** vector, layered, or RAW vs flattened
4. **Inspect file:** dimensions, aspect ratio, orientation, transparency, color profile, metadata
5. **Load destination-specific file** if needed
6. **Make minimum safe transformation:** crop, resize, convert, compress, strip/preserve metadata, export
7. **Validate in destination context**

---

## Asset-Type Defaults

| Asset Type | Best Starting Point | Watch Out For |
|------------|---------------------|---------------|
| Photo | WebP or AVIF for web, JPEG fallback, layered/RAW master | Color profile shifts, overcompression |
| Product photo | JPEG or WebP, high-res clean master | White background, edge cleanup, zoom detail |
| Screenshot/UI | PNG or lossless WebP | JPEG blur, privacy leaks, unreadable text |
| Logo/icon | SVG master, PNG fallbacks only | Tiny details, unsupported SVG pipelines |
| Social/OG card | PNG or high-quality JPEG | Unsafe crop, tiny text, double compression |
| Diagram/chart | SVG when possible, PNG when raster needed | Thin lines, low contrast |
| Print image | TIFF or high-quality JPEG with correct profile | Wrong profile, wrong physical size, no bleed |

---

## Core Rules

### 1. Choose Workflow by Destination

- Web delivery, social export, ecommerce prep, print output, and archive preservation are different jobs
- Screenshot, product photo, logo, infographic, and print asset should not use same format/compression
- If destination is specialized, read matching file before locking decisions

### 2. Pick Formats by Content

| Content | Format |
|---------|--------|
| Photos | AVIF or WebP (modern web), JPEG (compatibility) |
| Screenshots, UI, diagrams, text-heavy | PNG or lossless WebP |
| Logos, icons, simple illustrations | SVG when supported |
| Transparency needed | PNG, WebP, or AVIF (not JPEG) |
| Animation | WebP, MP4, or WebM (not GIF) |
| Master/archive | TIFF, PSD, layered formats, RAW |

### 3. Preserve Color, Transparency, Detail

- Web assets: sRGB unless destination needs otherwise
- Stripping ICC profiles can shift colors
- Transparent assets need alpha-safe formats
- Repeated lossy saves compound damage

### 4. Resize, Crop, Compress in Right Order

1. Decide aspect ratio
2. Crop
3. Resize
4. Compress

- Do not upscale by default
- Retina: 2x is normal, 3x should be deliberate
- Social cards, ecommerce slots crop aggressively — protect focal area

### 5. Metadata and Orientation

- EXIF orientation can rotate images unexpectedly
- Public web assets should strip GPS and unnecessary camera metadata
- Copyright, author metadata may need preservation

### 6. Practical Budgets

| Image Type | Size Budget |
|------------|-------------|
| Hero image | Under 200 KB |
| Content image | Under 100 KB |
| Thumbnail | Under 30 KB |
| Raster icon | Under 5 KB |

- Reserve layout space with explicit dimensions
- Do not lazy-load LCP/hero image

### 7. Validate Against Destination

- Platform specs are not interchangeable
- Ecommerce: background consistency, edge cleanliness, zoom detail
- Social: safe composition for different feed crops
- Print: physical size, bleed, color handling

### 8. Batch Safely

- Work from originals, not already-optimized outputs
- Spot-check before batch processing
- Keep per-destination exports separated from masters

---

## Common Traps

| Mistake | Consequence |
|---------|-------------|
| Saving transparent images as JPEG | Lost alpha channel |
| JPEG for screenshots | Blurry text |
| Wrong aspect ratio with correct dimensions | Unsafe crop |
| Recompressing same JPEG multiple times | Quality degradation |
| Stripping metadata blindly | Broken orientation, lost licensing info |
| Forgetting sRGB | Color shifts between tools |
| Using SVG where platform doesn't support it | Broken display |
| Embedding critical text in images | Accessibility issues, hard to update |
| Rasterizing logo too early | Blurry exports forever |

---

## When to Use This Skill

- Optimize images for web delivery
- Prepare product photos for ecommerce
- Create social media assets
- Export for print
- Process screenshots for documentation
- Handle logos and icons correctly
- Ensure image accessibility

---

## Related Skills

- **image-edit** — Masking, cleanup, inpainting, targeted edits
- **image-generation** — AI image generation
- **photography** — Capture, color, print workflows
- **svg** — Vector graphics workflows
- **ecommerce** — Marketplace product requirements
