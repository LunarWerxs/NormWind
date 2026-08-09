// SARIF 2.1.0 output for GitHub code scanning and similar dashboards.

// SARIF 2.1.0, the format GitHub code scanning and most CI dashboards ingest.
// Every finding is a `warning`: NormWind reports normalization opportunities,
// not defects, and a hard `error` level would misrepresent that in a security
// dashboard.
export function buildSarifReport(findings, lintedFiles, { version, ruleId }) {
    return {
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        version: "2.1.0",
        runs: [
            {
                tool: {
                    driver: {
                        name: "NormWind",
                        version,
                        informationUri: "https://github.com/LunarWerxs/NormWind",
                        rules: [
                            {
                                id: ruleId,
                                name: "EnforcesShorthand",
                                shortDescription: { text: "Tailwind classes can be normalized" },
                                fullDescription: {
                                    text: "Combinations of Tailwind utility classes that collapse into a shorter canonical form without changing the rendered CSS.",
                                },
                                helpUri: "https://github.com/LunarWerxs/NormWind#what-normwind-checks",
                                defaultConfiguration: { level: "warning" },
                            },
                        ],
                    },
                },
                invocations: [
                    {
                        executionSuccessful: true,
                        properties: { lintedFiles },
                    },
                ],
                results: findings.map((finding) => ({
                    ruleId,
                    level: "warning",
                    message: { text: finding.message },
                    locations: [
                        {
                            physicalLocation: {
                                artifactLocation: { uri: finding.filePath },
                                region: { startLine: finding.line, startColumn: finding.column },
                            },
                        },
                    ],
                })),
            },
        ],
    };
}
