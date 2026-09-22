# RADICO KHAITAN — AI CREATIVE QC INTELLIGENCE
## Master Knowledge & QC Architecture
### Version 1.0 — September 2026

---

## 1. PURPOSE

This document defines the knowledge architecture, brand universe, QC logic, rule schema, evaluation workflow, output schema, and training principles for an AI-powered Creative Quality Control (QC) system for Radico Khaitan.

The system evaluates static creatives, videos, reels, social assets, campaign creatives, and related brand communication against the correct combination of:

1. Global Radico rules
2. Category rules
3. Brand rules
4. Product / variant rules
5. Market-specific rules
6. Format-specific rules
7. Campaign-specific requirements
8. Approved creative references

### Core principle

> A creative must not be judged in isolation. It must be judged against the correct brand + product + market + format + campaign context.

The model must distinguish between mandatory requirements, prohibited elements, preferred creative behaviour, allowed elements, conditional rules, market-specific rules, and human-review cases.

The system must never invent rules that are not present in the knowledge base.

---

# 2. CORE QC PHILOSOPHY

## 2.1 Context Before Judgement

Before evaluating a creative, establish:

```text
Brand
↓
Category
↓
Product
↓
Variant / Flavour
↓
Market
↓
Format
↓
Campaign
```

## 2.2 Rule Hierarchy

```text
GLOBAL RADICO RULES
        ↓
CATEGORY RULES
        ↓
BRAND RULES
        ↓
PRODUCT / VARIANT RULES
        ↓
MARKET RULES
        ↓
FORMAT RULES
        ↓
CAMPAIGN BRIEF
        ↓
CREATIVE REFERENCES
```

Higher-level rules apply unless a lower-level rule explicitly overrides or qualifies them.

## 2.3 References Are Not Rules

Approved creative references are used to understand:
- Visual language
- Composition
- Photography
- Lighting
- Typography
- Product treatment
- Colour usage
- Lifestyle treatment
- Premiumisation
- Tone

References must NOT automatically become mandatory rules.

Example:

If 20 approved creatives use a particular glass, the system must not conclude that the glass is mandatory. It should treat the glass as a recurring approved visual pattern.

---

# 3. SYSTEM ARCHITECTURE

```text
                    CREATIVE INPUT
                Image / Video / PDF
                         |
                         v
                CREATIVE ANALYSER
       Vision / OCR / Audio / Object Detection
                         |
                         v
              CONTEXT IDENTIFICATION
        Brand → Product → Market → Format
                         |
                         v
                  RULE RETRIEVAL
                         |
        +----------------+----------------+
        |                |                |
     GLOBAL          BRAND/PRODUCT      MARKET
     RULES             RULES            RULES
        |                |                |
        +----------------+----------------+
                         |
                         v
                   QC EVALUATION
                         |
          +--------------+--------------+
          |                             |
        PASS                    FLAG / HUMAN REVIEW
          |                             |
          +--------------+--------------+
                         |
                         v
                   QC REPORT JSON
                         |
                         v
                   QC DASHBOARD/UI
```

---

# 4. CREATIVE ANALYSIS LAYER

## 4.1 Visual Detection

Detect where applicable:

- Brand logo
- Product pack
- Bottle
- Label
- Cap
- Liquid colour
- Product name
- Flavour cues
- Ingredients
- Food
- Glassware
- Ice
- People
- Approximate age representation
- Clothing
- Environment
- Buildings
- Locations
- Cultural symbols
- Animals
- Wildlife
- Text
- CTA
- Tagline
- Competitor logos
- Competitor packaging
- Alcohol consumption
- Pouring
- Drinking
- Driving
- AI artefacts
- Distortion
- Unnatural anatomy
- Product manipulation

## 4.2 Text Analysis

Extract and evaluate:

- Brand name
- Product name
- Variant
- Flavour
- Tagline
- Claims
- CTA
- Spelling
- Grammar
- Punctuation
- Market terminology
- Competitor references
- Potentially problematic claims
- Alcohol-related claims
- Health claims
- Financial/social success claims

## 4.3 Video Analysis

For video assets evaluate:

- Brand identification
- Product identification
- Logo
- Pack visibility
- Pack integrity
- On-screen text
- VO
- Subtitles
- Spelling
- Product terminology
- Music
- Transitions
- Animation
- Continuity
- Colour grading
- AI artefacts
- Aspect ratio
- Resolution
- Disclaimer
- CTA
- Timing
- End screen

Every issue should include a timestamp wherever technically possible.

---

# 5. GLOBAL RADICO RULES

## RADICO-GLOBAL-001 — British English

TYPE: MANDATORY
SCOPE: Global

Radico communication should use British English spelling.

Use:

```text
Whisky
```

Do not default to:

```text
Whiskey
```

EXCEPTION:
If an official product name, registered asset, market requirement, or supplied client artwork explicitly requires different spelling, follow the official requirement and flag only if there is a conflict.

## RADICO-GLOBAL-002 — Logo Position

TYPE: MANDATORY
SCOPE: Global

Brand logo should be placed in the top-right corner unless a documented campaign/format exception exists.

## RADICO-GLOBAL-003 — Logo Integrity

TYPE: PROHIBITED
SCOPE: Global

Do not alter, distort, recolour, stretch, rotate, manipulate, or otherwise modify an approved brand logo.

## RADICO-GLOBAL-004 — Pack Visibility

TYPE: MANDATORY / CONTEXTUAL
SCOPE: Applicable product creatives

Where the creative is intended to communicate the product, the approved product pack should be visible unless the campaign brief explicitly permits a pack-free execution.

## RADICO-GLOBAL-005 — Pack Integrity

TYPE: PROHIBITED
SCOPE: Global

Product packaging must not be visually distorted or incorrectly generated.

Flag:
- Incorrect bottle proportions
- Incorrect label
- Incorrect logo
- Incorrect cap
- Incorrect bottle colour
- Incorrect liquid colour where relevant
- AI-generated packaging errors
- Missing or malformed packaging elements

## RADICO-GLOBAL-006 — Competitor Logos

TYPE: PROHIBITED
SCOPE: Global

Competitor brand logos should not appear unless explicitly required by an approved campaign/legal context.

## RADICO-GLOBAL-007 — Competitor-Like Packaging

TYPE: HUMAN_REVIEW
SCOPE: Global

Flag obvious competitor packaging or branding that may create confusion.

Do not flag generic shapes merely because they resemble another product.

## RADICO-GLOBAL-008 — Underage Representation

TYPE: PROHIBITED
SCOPE: Alcohol communication

Do not depict underage people consuming or participating in alcohol consumption.

Avoid obviously school/college-looking or underage-coded representation in alcohol consumption contexts.

## RADICO-GLOBAL-009 — Drinking & Driving

TYPE: PROHIBITED
SCOPE: Global alcohol communication

Do not depict or imply drinking and driving.

## RADICO-GLOBAL-010 — Excessive Drinking

TYPE: PROHIBITED
SCOPE: Global alcohol communication

Flag:
- Intoxication
- Drunk behaviour
- Excessive drinking
- Drinking contests
- Drinking games
- Encouragement of excessive consumption

## RADICO-GLOBAL-011 — Health Benefits

TYPE: PROHIBITED
SCOPE: Alcohol communication

Do not present alcohol as providing health benefits or medical benefits.

## RADICO-GLOBAL-012 — Professional / Financial Success Claims

TYPE: PROHIBITED
SCOPE: Alcohol communication

Do not imply that alcohol consumption directly causes:
- Professional success
- Financial success
- Social status
- Improved performance

unless specifically approved through applicable legal/client guidance.

## RADICO-GLOBAL-013 — Sensitive Cultural / Political References

TYPE: RESTRICTED / HUMAN_REVIEW
SCOPE: Global

Flag potentially sensitive:
- Political references
- Religious symbolism
- Religious figures
- Religious places
- National symbols
- Sensitive social issues

for human review unless explicitly approved for the campaign.

---

# 6. PRODUCT UNIVERSE

## WHISKY

### Mass Premium
- 8PM Classic
- 8PM Honey
- 8PM Fire
- 8PM Premium Black
- Whytehall Royal
- Whytehall Honey
- Whytehall Fire
- Whytehall Chocolate
- Burn Barrel
- Blue Finest
- Brown Barley

### Luxury / Premium Portfolio
- Rampur Asava
- Rampur Double Cask
- Rampur Barrel Blush
- Rampur Trigun
- Rampur Select
- Rampur Jugalbandi 7
- Rampur Jugalbandi 8
- Virasat
- Sangam
- Royal Ranthambore Whisky
- Ankahi

## RUM
- Afribull Café Rum
- Kohinoor Dark Rum
- Contessa

## BRANDY
- Morpheus

## GIN
- Jaisalmer Classic
- Jaisalmer Gold

## VODKA
- Magic Moments Plain Grain
- Magic Moments Raspberry
- Magic Moments Green Apple
- Magic Moments Lemongrass & Ginger
- Magic Moments Orange
- Magic Moments Chocolate
- Magic Moments Spicy Jamun Mint

---

# 7. BRAND INTELLIGENCE — 8PM

## Positioning
Mass Premium Whisky

## Brand Personality
- Bold
- Sophisticated
- Confident
- Strong masculine charisma
- Aspirational

“Masculine” should be interpreted as charisma/confidence, not aggression.

## Core Product
8PM Classic / Master Reserve / Master Blend territory.

Core communication should support:
- Boldness
- Classic whisky identity
- Master blend identity
- Confident lifestyle

## Brand Communication Associations
Known communication associations include:
- “Time of Your Life”
- “Time for Friends”

These should be treated as brand associations/reference language rather than automatically mandatory copy unless campaign guidance says otherwise.

---

# 8. 8PM HONEY

## Product Territory
Honey / Sweetness

## Preferred Communication
The flavour profile should be actively promoted or educated.

Literal or metaphorical representation is permitted.

## Allowed Visual Territory
- Honey
- Honeycomb
- Honey textures
- Golden tones
- Warm lighting
- Golden sunset
- Sweetness
- Warm moments
- Metaphorical representations of sweetness

## HARD PROHIBITION

Do NOT use:
- Bees
- Bee imagery
- Bee characters
- Bee illustrations
- Bee-related visual elements

Important boundary:

```text
Honey = allowed
Honeycomb = allowed
Sweetness = allowed
Bee = prohibited
```

Do not generalise the prohibition to honey itself.

---

# 9. 8PM FIRE

## Product Territory
Cinnamon-derived flavour with an end fiery kick on the palate.

## Preferred Communication
Flavour education and promotion are important.

## Visual Territory
Can use:
- Heat
- Fire
- Warmth
- Cinnamon-inspired cues
- Fiery metaphors

Do not invent unsupported ingredient/flavour claims beyond approved product knowledge.

---

# 10. 8PM VISUAL SYSTEM

## Preferred
- Bold
- Premium
- Strong typography
- Bold/dynamic compositions
- Cinematic/atmospheric
- Lifestyle
- Urban/contemporary

## Avoid
- Extremely youthful / teen-oriented
- Cheap/generic
- Cartoonish
- Extremely corporate
- Sloppy execution

## Colour
Brand colours should dominate where applicable.

Strictly preserve approved brand colours.

## People

Allowed broad adult lifestyle representation:
- Young adults
- Working professionals
- Friends/groups
- Couples
- Solo individuals
- Premium/lifestyle audiences

## Styling

Preferred:
- Smart casual
- Formal
- Premium / luxury

Avoid:
- School/college-looking people
- Obviously underage-looking people
- Excessively provocative clothing
- Sloppy/unappealing styling

## Locations

Allowed:
- Home
- Bar/lounge
- Restaurant
- Urban cityscape

Avoid:
- Religious places
- Hospitals
- Schools
- Places associated with children
- Workplaces
- Fitness/gym environments
- Driving environments

## Props

Allowed:
- Whisky glasses
- Ice
- Food
- Cigars
- Music-related props
- Lifestyle objects

---

# 11. 8PM COPY SYSTEM

## Preferred
- Bold
- Confident
- Aspirational
- Witty
- Premium

## Avoid
- Overly poetic
- Corporate
- Generic motivational
- Cringe/slang-heavy
- Overly complicated
- Aggressive
- Excessively casual

## Language
English.

## Slang
Avoid.

## Copy QC
Check:
- Spelling
- Grammar
- Product name
- Variant/flavour
- Claims
- Competitor references
- Negative/offensive language
- Sexualised communication
- Excessive drinking implications
- Unsupported claims

---

# 12. WHYTEHALL WHISKY

## Positioning
Premium Whisky

## Audience
Broadly similar to 8PM.

## Personality / Expression
- Royal
- Premium
- Sophisticated
- Refined
- Organised celebration

## Key Difference from 8PM

8PM can own a stronger party/social vibe.

Whytehall should feel like:

> A well-organised, refined celebration rather than a loud party.

Premium does not mean artificial “luxury for luxury's sake.”

The execution should feel:
- Refined
- Organised
- Sophisticated
- Elevated

---

# 13. WHYTEHALL PORTFOLIO

- Whytehall Royal
- Whytehall Chocolate
- Whytehall Fire
- Whytehall Honey

## Flavour Communication

Chocolate and Honey should actively communicate flavour profiles.

Literal or metaphorical flavour representation is allowed.

## Fire
Derived from cinnamon.

## Honey
Honey/sweetness territory is relevant.

Do not automatically transfer the 8PM Honey bee prohibition to Whytehall Honey unless a specific Whytehall rule is added later.

---

# 14. WHYTEHALL LOGO

TYPE: MANDATORY

- Logo must remain approved
- Logo colour cannot be changed
- Logo should be top-right

---

# 15. AFRIBULL CAFÉ RUM

## Positioning

Rum.

The product should NOT be communicated as a cheap product.

However, it should also NOT be artificially presented as an ultra-luxury product.

## Core Territory
- Café flavour notes
- African heritage
- African culture
- Rich cultural identity

## Visual Freedom

Broad creative freedom is allowed around:
- African cultural elements
- Café / coffee elements
- Lifestyle
- Sensory metaphors
- Heritage storytelling

Cultural representation should remain authentic and respectful.

## Branding
- Rum colour should remain accurate/consistent.
- Logo should remain consistent.
- Logo should be top-right.

## Avoid
- Cheap-looking execution
- Generic low-cost/value visual language
- Artificial luxury positioning

---

# 16. MAGIC MOMENTS VODKA

## Positioning
Mass Premium Vodka

## Brand Personality
- Fun
- Party
- Chill
- Social
- Contemporary

It is widely consumed and should not be treated as an ultra-luxury product.

## Portfolio
- Magic Moments Plain Grain
- Magic Moments Raspberry
- Magic Moments Green Apple
- Magic Moments Lemongrass & Ginger
- Magic Moments Orange
- Magic Moments Chocolate
- Magic Moments Spicy Jamun Mint

## Product Communication

Flavours are a major creative territory.

Literal or metaphorical flavour representation is allowed.

## Brand Copy Territory

Strong recurring language:
- “Magic Moments”
- “Flavor of Your Life”
- “Make Every Moment a Magic Moment”

“Magic Moments” should be actively considered in creative copy because it strengthens brand linkage.

Unless a campaign explicitly makes it mandatory, absence should not automatically be treated as a compliance failure.

## Logo

Approved logo colours:
- Blue
- White

Both are valid.

Logo:
- Top-right
- Do not recolour outside approved colours

---

# 17. RAMPUR / LUXURY PORTFOLIO

## Positioning
Luxury / Premium Whisky portfolio.

The portfolio is known for highly luxurious and premium whisky communication.

## Known Products
- Rampur Double Cask
- Rampur Asava
- Rampur Barrel Blush
- Rampur Trigun
- Rampur Select
- Sangam
- Virasat
- Jugalbandi 7
- Jugalbandi 8
- Ankahi

## Logo System

Two recognised logo identities exist:

1. Rampur Distillery
2. Rampur Indian Single Malt Whisky

The correct logo depends on:
- Client requirement
- Campaign requirement
- Product requirement

Therefore the QC system must NOT assume one logo is universally correct.

Both logo identities can be valid when contextually appropriate.

Logo placement remains top-right unless an approved exception exists.

## Creative Territory

Luxury should be expressed through the complete execution:
- Copy
- Composition
- Photography
- Lighting
- Props
- Environment
- Typography
- Product treatment

Do not reduce “luxury” to a single visual cue.

Avoid mass-market, cheap, casual or excessively loud treatment where inconsistent with the relevant luxury product.

Important:

Product-specific rules must be added before the system makes highly specific claims about individual Rampur variants.

---

# 18. BLUE FINEST WHISKY

## Positioning
Mass Premium Whisky

## Market-Specific Terminology

### Thailand
Use:

> Blue Finest Whisky Spirit

### Africa / Rest of Africa
Use:

> Blue Finest Whisky

Terminology must always be evaluated against the target market.

Do not create a universal rule that one terminology is correct everywhere.

Examples:

```text
Thailand + “Whisky Spirit” = PASS
Africa + “Whisky” = PASS
```

Market terminology mismatch should be flagged.

---

# 19. ROYAL RANTHAMBORE WHISKY

## Positioning
Premium Whisky

## Core Brand Territory
- Royalty
- Ranthambore
- Rajasthan
- Indian royal heritage
- Tiger
- Majestic character
- Premium Indian whisky

## Key Association

Ranthambore is strongly associated with:
- Tiger
- Royalty
- Indian heritage

Tiger imagery is therefore a relevant and approved brand association.

## Tagline

> “India’s Finest Yet”

Treat this as an established brand tagline.

Do not automatically force the tagline into every execution unless the campaign brief requires it.

## Visual Direction

Preferred:
- Royal
- Majestic
- Premium
- Refined
- Indian heritage
- Rajasthan-inspired cues
- Sophisticated tiger representation

## Tiger Rule

Tiger imagery can be used as a positive brand cue.

The QC engine must NOT treat all wildlife imagery as inherently inappropriate.

However, flag:
- Cheap/gimmicky tiger treatment
- Cartoonish tiger representation
- Generic wildlife treatment that weakens premium positioning

Use human review where the distinction is subjective.

## Logo
- Top-right
- Approved logo integrity must be maintained

---

# 20. RULE TYPES

Every rule should use one of these classifications.

## MANDATORY
Must be present or followed.

## PROHIBITED
Must not occur.

## PREFERRED
Recommended, but absence alone is not a violation.

## ALLOWED
Explicitly permitted.

## CONDITIONAL
Applies only if a stated condition exists.

## CONTEXTUAL
Depends on market, campaign, product or format.

## HUMAN_REVIEW
Model should escalate instead of making a hard judgement.

---

# 21. SEVERITY

## CRITICAL
Potentially serious legal/compliance or major brand integrity concern.

## MAJOR
Clear brand/product/market violation.

## MINOR
Executional issue with limited impact.

## INFORMATIONAL
Observation, optimisation, or recommendation.

Severity must not automatically determine rejection.

Recommended status values:

```text
PASS
FLAG
HUMAN_REVIEW
NOT_APPLICABLE
```

---

# 22. CONFIDENCE LOGIC

Recommended confidence handling:

```text
> 90%
High confidence
Model can make a decision where rule/evidence is clear.

70–90%
Medium confidence
Flag or consider human review depending on severity.

< 70%
Low confidence
Human review.
```

Exact thresholds can be tuned using validation data.

The system must not force a binary decision when visual evidence is ambiguous.

---

# 23. MACHINE-READABLE RULE SCHEMA

Every rule should ideally follow this structure:

```json
{
  "rule_id": "8PM_HONEY_VIS_001",
  "scope": {
    "category": "Whisky",
    "brand": "8PM",
    "product": "8PM Honey",
    "variant": "Honey",
    "market": "GLOBAL",
    "format": "ALL"
  },
  "domain": "Visual",
  "rule_type": "PROHIBITED",
  "severity": "MAJOR",
  "rule": "Bee imagery must not be used.",
  "rationale": "Honey is an approved flavour territory, but bee imagery is specifically prohibited.",
  "allowed": [
    "Honey",
    "Honeycomb",
    "Golden tones",
    "Sweetness metaphors"
  ],
  "prohibited": [
    "Bees",
    "Bee characters",
    "Bee illustrations"
  ],
  "detection_method": [
    "Object detection",
    "Image understanding"
  ],
  "human_review": true
}
```

---

# 24. RECOMMENDED RULE DOMAINS

Use standard domain tags:

```text
Brand Identity
Logo
Pack / Product
Visual
Copy
Flavour
People
Styling
Environment
Props
Cultural
Alcohol Compliance
Legal / Compliance
Market
Language
Typography
Audio
VO
Subtitles
Technical
Animation
AI Artefact
Competitor
CTA
Campaign
```

---

# 25. EXAMPLE MACHINE-READABLE RULES

## Logo

```json
{
  "rule_id": "RADICO_GLOBAL_LOGO_001",
  "scope": {
    "brand": "ALL",
    "format": "ALL"
  },
  "domain": "Logo",
  "rule_type": "MANDATORY",
  "severity": "MAJOR",
  "rule": "Approved brand logo should appear in the top-right corner unless an approved exception exists.",
  "human_review": true
}
```

## Blue Finest Market

```json
{
  "rule_id": "BLUE_FINEST_MARKET_001",
  "scope": {
    "brand": "Blue Finest",
    "market": "Thailand"
  },
  "domain": "Market",
  "rule_type": "CONDITIONAL",
  "severity": "MAJOR",
  "rule": "Product terminology should use 'Blue Finest Whisky Spirit' for Thailand.",
  "human_review": true
}
```

## Royal Ranthambore Tiger

```json
{
  "rule_id": "RR_VIS_001",
  "scope": {
    "brand": "Royal Ranthambore Whisky"
  },
  "domain": "Visual",
  "rule_type": "ALLOWED",
  "severity": "INFORMATIONAL",
  "rule": "Tiger imagery is an approved brand association connected to Ranthambore and the brand's royal heritage.",
  "human_review": true
}
```

---

# 26. QC EVALUATION PIPELINE

## STEP 1 — Identify Asset

Determine:
- Static / Video / Reel / Carousel / OOH / Other
- Resolution
- Aspect ratio
- Duration if video

## STEP 2 — Identify Context

Determine:
- Brand
- Product
- Variant
- Market
- Format
- Campaign

If uncertain, request or infer only where confidence is sufficient.

## STEP 3 — Extract Evidence

Run:
- OCR
- Object detection
- Scene analysis
- People analysis
- Product/pack analysis
- Audio/VO transcription
- Subtitle extraction

## STEP 4 — Retrieve Rules

Load:

```text
Global
+
Category
+
Brand
+
Product
+
Variant
+
Market
+
Format
+
Campaign
```

## STEP 5 — Evaluate

Each rule should produce:

```text
PASS
FLAG
HUMAN_REVIEW
NOT_APPLICABLE
```

## STEP 6 — Generate Evidence

Every flagged issue should contain:
- Rule ID
- Finding
- Evidence
- Location/timestamp
- Severity
- Confidence
- Recommendation

## STEP 7 — Generate Final Report

Return:
- Overall status
- Rules checked
- Passed
- Flagged
- Human review
- Detailed findings
- Recommendations

---

# 27. OUTPUT SCHEMA

Recommended output:

```json
{
  "qc_status": "HUMAN_REVIEW",
  "confidence": 0.91,

  "creative_context": {
    "brand": "Royal Ranthambore Whisky",
    "product": "Royal Ranthambore Whisky",
    "market": "India",
    "format": "Static",
    "campaign": "Unknown"
  },

  "summary": {
    "rules_checked": 27,
    "passed": 24,
    "flagged": 2,
    "human_review": 1
  },

  "issues": [
    {
      "issue_id": "QC_001",
      "severity": "MAJOR",
      "category": "Brand",
      "rule_id": "RR_VIS_004",
      "finding": "Visual treatment may not sufficiently communicate premium positioning.",
      "evidence": "Overall composition",
      "confidence": 0.84,
      "recommendation": "Review environment, lighting and product treatment for stronger premium cues.",
      "status": "HUMAN_REVIEW"
    }
  ],

  "passed_checks": [
    "Logo positioned top-right",
    "Product pack visible",
    "Tiger association present",
    "British English spelling used"
  ]
}
```

---

# 28. TRAINING DATA ARCHITECTURE

The model should not be trained only on brand descriptions.

Use five datasets.

## DATASET 01 — BRAND KNOWLEDGE

Contains:
- Positioning
- Personality
- Brand territory
- Audience
- Product portfolio
- Taglines
- Visual language
- Copy language

## DATASET 02 — RULES

Contains:
- Rule ID
- Scope
- Condition
- Allowed
- Prohibited
- Severity
- Detection method
- Exception
- Human review

## DATASET 03 — APPROVED REFERENCES

Contains:
- Asset
- Brand
- Product
- Market
- Format
- Visual characteristics
- Copy characteristics
- Product treatment
- Notes

## DATASET 04 — QC EXAMPLES

Each example should contain:

```text
Creative
↓
Detected evidence
↓
Applicable rule
↓
Reasoning
↓
Decision
↓
Recommended correction
```

## DATASET 05 — EDGE CASES

Examples:

```text
8PM Honey + Honeycomb → PASS
8PM Honey + Bee → FLAG

Royal Ranthambore + Tiger → PASS
Royal Ranthambore + Cartoon Tiger → HUMAN_REVIEW / FLAG depending on execution

Blue Finest + Whisky Spirit + Thailand → PASS
Blue Finest + Whisky Spirit + Africa → FLAG

Magic Moments + Blue logo → PASS
Magic Moments + White logo → PASS
Magic Moments + Unapproved logo colour → FLAG
```

---

# 29. EDGE-CASE TRAINING PRINCIPLE

Teach boundaries, not just obvious examples.

Bad training:

```text
Bee = bad
```

Good training:

```text
8PM Honey:
Honey = PASS
Honeycomb = PASS
Golden sweetness = PASS
Bee = FLAG
Bee character = FLAG
Flower = context-dependent
```

The model needs to understand the semantic boundary of the rule.

---

# 30. HUMAN REVIEW PRINCIPLE

Human review should be used when:
- Evidence is ambiguous
- Creative quality is subjective
- A potential cultural sensitivity exists
- Premiumisation is difficult to classify
- Competitor similarity is uncertain
- A visual object cannot be identified confidently
- A rule conflict exists
- The campaign brief overrides a default rule

Example:

```text
Potential tiger detected.
Confidence: 61%
Action: HUMAN_REVIEW
```

Do not convert uncertain evidence into a hard violation.

---

# 31. DO NOT ALLOW THE MODEL TO INVENT RULES

The model must not infer:

> “I personally think this is not premium.”

Instead:

```text
APPLICABLE RULE:
Premium visual treatment required.

OBSERVATION:
Current composition uses casual, low-production-value visual treatment.

DECISION:
HUMAN_REVIEW / FLAG based on confidence and configured severity.
```

The model should always connect its judgement to an explicit rule.

---

# 32. DO NOT OVERFIT TO REFERENCES

The model must distinguish:

```text
RULE
vs.
REFERENCE PATTERN
```

A reference demonstrates what has been approved.

It does not automatically demonstrate what is mandatory.

The model should be able to approve a creative that looks different from references if it still satisfies the applicable rules.

---

# 33. CREATIVE REFERENCE INGESTION

When references are uploaded, extract structured metadata from every asset.

Recommended metadata:

```json
{
  "asset_id": "RR_REF_001",
  "brand": "Royal Ranthambore Whisky",
  "product": "Royal Ranthambore Whisky",
  "market": "India",
  "format": "Static",
  "visual_attributes": [
    "Premium",
    "Royal",
    "Indian heritage",
    "Tiger symbolism"
  ],
  "composition": [
    "Product-led",
    "Negative space"
  ],
  "lighting": [
    "Cinematic",
    "Warm"
  ],
  "reference_strength": "APPROVED_REFERENCE",
  "is_rule": false
}
```

---

# 34. CONFLICT RESOLUTION

If two rules appear to conflict:

1. Check whether one is more specific.
2. Check market.
3. Check product/variant.
4. Check campaign brief.
5. Check whether an explicit exception exists.
6. If unresolved → HUMAN_REVIEW.

Example:

```text
Global Rule
"Whisky"

vs.

Market Rule
"Whisky Spirit"

Market-specific rule wins for the applicable market.
```

---

# 35. PRODUCT RULE INHERITANCE

A product inherits:

```text
Global
+
Category
+
Brand
```

Then adds:

```text
Product
+
Variant
+
Market
+
Format
```

Example:

```text
8PM Honey
│
├── Global Radico rules
├── Whisky category rules
├── 8PM brand rules
└── Honey variant rules
```

This prevents duplicated rules and makes the knowledge base scalable.

---

# 36. RECOMMENDED KNOWLEDGE BASE STRUCTURE

```text
/RADICO_QC/
│
├── 00_GLOBAL/
│   ├── global_rules.md
│   ├── global_rules.json
│   └── compliance_rules.json
│
├── 01_CATEGORIES/
│   ├── whisky.md
│   ├── rum.md
│   ├── vodka.md
│   ├── gin.md
│   └── brandy.md
│
├── 02_BRANDS/
│   ├── 8pm/
│   ├── whytehall/
│   ├── afribull/
│   ├── magic_moments/
│   ├── rampur/
│   ├── blue_finest/
│   └── royal_ranthambore/
│
├── 03_PRODUCTS/
│   ├── variants/
│   └── flavour_rules/
│
├── 04_MARKETS/
│   ├── india/
│   ├── thailand/
│   ├── africa/
│   └── market_overrides.json
│
├── 05_FORMATS/
│   ├── static/
│   ├── video/
│   ├── reel/
│   ├── carousel/
│   └── ooh/
│
├── 06_REFERENCES/
│   ├── approved/
│   └── reference_metadata.json
│
├── 07_QC_EXAMPLES/
│   ├── pass/
│   ├── flag/
│   └── edge_cases/
│
└── 08_OUTPUT/
    ├── qc_schema.json
    └── report_template.md
```

---

# 37. CURRENT KNOWLEDGE MATURITY

Current knowledge is strongest for:
- 8PM
- Whytehall
- Afribull Café Rum
- Magic Moments
- Blue Finest
- Royal Ranthambore
- Rampur portfolio-level positioning

The following require additional product-specific knowledge before detailed QC rules are created:
- Individual Rampur variants
- Kohinoor
- Contessa
- Morpheus
- Jaisalmer
- Burn Barrel
- Brown Barley
- 8PM Premium Black
- Virasat-specific details
- Sangam-specific details
- Ankahi-specific details

Do not fabricate product rules for these products.

---

# 38. CURRENT RULES VS FUTURE RULES

Every knowledge item should be tagged:

```text
CONFIRMED
INFERRED
REFERENCE
PENDING
```

Only CONFIRMED rules should be used as hard QC requirements.

INFERRED rules should be used cautiously and preferably routed to human review.

REFERENCE information should influence style understanding but should not become mandatory.

PENDING information should not be used for violation decisions.

---

# 39. GOLDEN SYSTEM PROMPT

Use the following as the foundation of the QC reasoning layer:

```text
You are Radico Khaitan's Creative QC Intelligence Engine.

Your job is to evaluate creative assets against the applicable
Radico Khaitan brand, product, market, format, campaign and
compliance rules.

Do not judge a creative in isolation.

First identify:
Brand
Category
Product
Variant
Market
Format
Campaign

Then retrieve the applicable rules.

Use the following hierarchy:

Global Rules
Category Rules
Brand Rules
Product / Variant Rules
Market Rules
Format Rules
Campaign Brief
Creative References

Never invent a rule.

Never treat a creative reference as a mandatory rule unless
the knowledge base explicitly marks it as mandatory.

Do not generalise product-specific rules to other products.

Do not generalise market-specific rules globally.

For every finding, identify the applicable rule and provide
visual/textual evidence.

If evidence is insufficient or subjective, use HUMAN_REVIEW.

Distinguish between:
PASS
FLAG
HUMAN_REVIEW
NOT_APPLICABLE

For every flagged issue provide:
Rule ID
Category
Severity
Finding
Evidence
Confidence
Recommendation

Maintain British English spelling, including "Whisky",
unless an official product/market requirement explicitly
specifies otherwise.

Preserve approved logos and packaging.

Do not make unsupported product, flavour, health, legal,
competitive or cultural claims.

The objective is consistent, explainable, brand-aware QC,
not subjective aesthetic judgement.
```

---

# 40. FINAL OPERATING PRINCIPLE

The system should behave like a combination of:

```text
Brand Guardian
+
Compliance Checker
+
Product Specialist
+
Market Specialist
+
Creative QC Reviewer
```

It should NOT behave like:

```text
Generic AI Art Critic
```

Every final finding should be traceable:

```text
WHAT WAS DETECTED?
        ↓
WHICH RULE APPLIES?
        ↓
WHAT EVIDENCE SUPPORTS IT?
        ↓
WHAT IS THE CONFIDENCE?
        ↓
PASS / FLAG / HUMAN REVIEW
        ↓
WHAT SHOULD BE CHANGED?
```

This traceability is essential for training, debugging, client confidence, and continuous improvement.

---

# 41. FUTURE EXPANSION

As more brand information becomes available, add:

- Individual product flavour profiles
- Product-specific taglines
- Approved colour palettes
- Typography systems
- Pack reference images
- Logo reference files
- Approved / prohibited props
- Approved environments
- Market-specific legal requirements
- Market-specific terminology
- Campaign-specific rules
- More approved references
- More failed creative examples
- Human QC corrections
- Historical QC decisions

Every human correction should ideally become a future training example.

The system should continuously evolve from:

```text
RULES
+
REFERENCES
+
REAL QC EXAMPLES
+
HUMAN CORRECTIONS
```

into a progressively more accurate Radico Creative Intelligence system.
