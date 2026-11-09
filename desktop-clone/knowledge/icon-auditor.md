# Tool Icon Auditor for repository contributors

The Tool Icon Auditor is a separate local development app available in a TinyGPT source checkout. It is not a setting or built-in editor in the installed desktop release. Repository contributors can open the **Open Tool Icon Auditor.cmd** launcher after the checkout's desktop dependencies are installed.

## Refresh and review tools

Choose **Refresh latest tools** to read the current production source without closing the auditor. The catalog includes built-in, desktop, Coding agent, Work, connector and local plugin declarations, plus host-generated activities such as conversation optimization. **New tools** marks newly discovered entries for review. The refresh timestamp identifies a source snapshot, not a separately installed or packaged release.

Icons are rendered through the production icon resolver. Explicit per-tool mappings take precedence over family defaults. Browser actions without an individual mapping use the globe icon; selected browser actions can instead show a window, cursor, keyboard, mouse or camera. Connected extension tools default to the plug icon, while specific connector or local-plugin actions can have their own mappings. Historical bot-prefixed activity defaults to the bot icon. These visual choices do not change which actions are available or permitted. Running and completed labels preview host fallback text. Actual tool summaries and model-authored status text may vary.

## Record icon choices

Select a tool, paste a Solar Linear slug or choose an icon from the installed catalog, then select **Save replacement**. Choices are saved in the checkout's local change file and survive closing or refreshing the auditor. **Applied** means the current production icon matches a saved choice. **Pending changes** lists choices that still differ. **Recorded changes** retains all saved choices, including choices for retired tools.

**Copy update request** copies only pending choices for current editable tools. Paste that request into the development assistant when ready to apply the mappings. Recording a choice does not modify TinyGPT's production icons automatically. An already-applied choice is retained until explicitly removed.

## Scope and limitations

The auditor does not connect to accounts, inspect private account data or query live remote MCP tool catalogs. Dynamic families represent tools whose names are discovered at connection time; they do not prove that a particular account action is currently available. Some actions have separate result displays or no rendered toolchain row. The auditor marks these differences. It does not change permissions, run the represented actions, install missing services or grant account access.
