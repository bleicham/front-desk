# DMA-PRIME EHR Protocol Code Lists (2025)

This repository contains the clinical code lists used by the DMA-PRIME research center to identify conditions of interest, testing, and vaccination events within electronic health record (EHR) data. These lists are maintained and updated by the study team and are intended to support reproducible, transparent identification of cases across participating health systems. Contact Emily Serman (eserman@clemson.edu) with questions.

---

## Code System Sources

The table below lists the coding systems used in this protocol and where codes were sourced from. Always read descriptions carefully when pulling codes from these systems — codes that appear relevant by name may refer to a different pathogen, condition, or context.

| Code Name | Source | Notes |
|-----------|--------|-------|
| LOINC | https://loinc.org/search/ | Account required to search, but registration is free |
| CPT | https://www.aapc.com/codes/cpt-codes-range/ | Searchable by code or condition name. Always verify descriptions — codes are not always relevant to the intended pathogen or condition |
| CVX | https://www2.cdc.gov/vaccines/iis/iisstandards/vaccines.asp?rpt=cvx | Created and maintained by the CDC; check this site for updates |
| RXNorm | https://mor.nlm.nih.gov/RxNav/ | Searchable by drug name or code. API documentation at https://lhncbc.nlm.nih.gov/RxNav/applications/RxNavDoc.html |
| ICD-10 | https://www.aapc.com/codes/code-search/ | Searchable via AAPC for both ICD-10 and CPT codes. Cross-check against the official CMS code lists at https://www.cms.gov/medicare/coding-billing/icd-10-codes, which are updated annually |

---

## Condition-Specific Notes and Sources

The table below documents protocol decisions, rationale, and reference sources for each condition of interest. Researchers should review these notes before applying the code lists.

| Condition | Notes | Source Links |
|-----------|-------|--------------|
| Chlamydia | Protocol includes the A55, A56, and A74 ICD-10 code ranges. A55 (LGV) is included in the general chlamydia category, but researchers should note the invasiveness of the condition if cases emerge. Trachoma (spread primarily by flies rather than sexual contact) is excluded from the STI category. Chlamydial conjunctivitis (A74) is included as STI-related. | https://www.sciencedirect.com/science/article/pii/S0264410X21003261 \| https://www.who.int/news-room/fact-sheets/detail/trachoma |
| HSV | Uses codes B00.xx, A60.xx, and P35.2. Note that ICD-10 codes do not distinguish between HSV-1 and HSV-2. | https://pmc.ncbi.nlm.nih.gov/articles/PMC12088598/ |
| Syphilis | Based on Supplemental Table 1 of the reference paper. Pregnancy-related codes are under review. | https://jamanetwork.com/journals/jamaophthalmology/fullarticle/2812271 |
| HPV | Includes codes identifying HPV through positive tests, as well as codes for anal cavity and anogenital (venereal) warts, which are explicitly HPV-related even though they are not listed in insurance provider coding guidelines. Related cancer codes are excluded at this time, consistent with the protocol's approach of excluding screening and immunization codes for conditions not directly diagnosed. | https://www.cdc.gov/cancer/hpv/basic-information.html \| https://providernews.anthem.com/new-york/articles/human-papillomavirus-documentation-coding-and-tips-for-succe-19205 |
| Spotted Fever Rickettsioses | Renamed from "RMSF" to the broader "Spotted fever rickettsioses" category to include all relevant ICD-10 codes. LOINC codes included in the protocol are based on the CDC Yellow Book list of Rickettsia species that cause spotted fevers. | https://www.nature.com/articles/s41598-021-96463-9#MOESM1 \| https://www.cdc.gov/yellow-book/hcp/travel-associated-infections-diseases/rickettsial-diseases.html |
| Ehrlichiosis | Codes reference all Ehrlichiosis species. The CDC Yellow Book page is particularly important for identifying LOINC codes. Note: the CDC Yellow Book does not list *E. chaffeensis*, but it is a primary cause of ehrlichiosis in the US and is included in both ICD-10 and LOINC codes in this protocol. | https://www.nature.com/articles/s41598-021-96463-9#MOESM1 \| https://www.cdc.gov/ehrlichiosis/about/index.html \| https://www.cdc.gov/yellow-book/hcp/travel-associated-infections-diseases/rickettsial-diseases.html |
| General STI | The ForwardHealth page provides a useful (though incomplete) list of CPT codes for cross-checking with the AAPC site. The CDC AtlasPlus page is useful for reviewing state-level STI trends alongside study data. | https://www.forwardhealth.wi.gov/kw/html/2624_Procedure%20Codes.html \| https://www.cdc.gov/nchhstp/about/atlasplus.html |

---

## Code Identification Strategy

### Diagnoses

For identifying diagnoses, this protocol uses **ICD-10-CM codes**. Code ranges and specific codes for each condition are listed in the `ICD-10` tab of the code list file.

To pull the ICD-10 codes used by this protocol, open
`DMA_PRIME_codes. 2025 final version - github.xlsx`, select the `ICD-10` tab,
take the identifier from the `Code` column, and filter with the `Condition`
column. Read the `Description` and any `Start Date` / `End Date` restrictions
before applying a code. For provenance and annual verification links, use rows
7–8 of the `Sources - General code lists` tab and the **Code System Sources**
section of this README.

### Testing and Vaccination

For identifying testing and vaccination events, this protocol uses a **dual-search strategy** combining structured codes and wildcard text searches. This approach is necessary because health systems do not consistently populate LOINC or CVX codes in their EHR data — these fields are frequently missing, inconsistently coded, or system-dependent.

**Structured codes used:**

- **CPT codes** — for both testing and vaccination events
- **CVX codes** — for vaccination events (CDC-maintained vaccine codes)
- **LOINC codes** — for laboratory and testing events

**Wildcard text searches** are applied to free-text and description fields to capture records that lack structured codes. These searches use the names of test types, pathogens, and vaccine products as they appear in LOINC descriptions and common clinical terminology. For example, LOINC long names and short names for relevant assays are used as search terms to capture records where the LOINC code itself is absent but the test description is present.

Using both strategies together maximizes case capture across health systems with varying levels of coding completeness.

---

## COVID-19 Coding Note

For COVID-19, the protocol uses **3 of the 5 ICD-10 codes** in the code list for specific date ranges, consistent with CDC guidelines in effect during those periods. The codes with date restrictions reflect periods when placeholder and surrogate codes (such as B34.2, B97.29, and J80) were in use before the dedicated COVID-19 code (U07.1) was available and widely adopted.

| Code | Description | Date Range Applied |
|------|-------------|-------------------|
| B34.2 | Coronavirus infection, unspecified | 2020-03-06 through 2020-12-29 |
| B97.29 | Other coronavirus as the cause of diseases classified elsewhere | 2020-03-06 through 2020-04-01 |
| J12.82 | Pneumonia due to coronavirus disease 2019 | All dates (no restriction) |
| J80 | Acute respiratory distress syndrome (ARDS) | 2020-03-06 through 2020-12-29 |
| U07.1 | COVID-19 virus identified | All dates (no restriction) |

The date-restricted codes (B34.2, B97.29, and J80) were used during the early pandemic period as provisional or non-specific codes before U07.1 was introduced and standardized. Their use is limited to the date windows above, following CDC guidance on the transition to the dedicated COVID-19 code. J12.82 and U07.1 are applied without date restriction.

---

## Repository Contents

| File | Description |
|------|-------------|
| `DMA_PRIME_codes. 2025 final version - github.xlsx` | Master code list workbook containing all conditions, code types, and source references |

**Workbook tabs:**

| Tab | Contents |
|-----|----------|
| Sources - General code lists | Links and notes for each coding system (LOINC, CPT, CVX, RXNorm, ICD-10) |
| Sources - disease | Condition-specific rationale, protocol decisions, and reference links |
| ICD-10 | ICD-10-CM diagnosis codes for all conditions of interest |
| LOINC | LOINC codes for laboratory and testing events |
| CVX | CVX vaccine codes |
| CPT | CPT codes for testing, vaccination, and treatment events |
| RXNorm | Drug codes (where applicable) |
| Social History | Social history-related codes |

---

## Contact and Updates

This code list reflects the 2025 final version of the DMA-PRIME protocol. For questions about code selection rationale or updates, contact Emily Serman (eserman@clemson.edu).
