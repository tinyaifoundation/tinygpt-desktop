# Plugins, connected accounts, MCP and skills

Open Settings → Plugins to manage integrations, accounts, selected knowledge, Skills and custom MCP servers. Plugins add tools for services such as mail, calendars, files and development systems. Available integrations depend on the catalog and configured connections; TinyGPT must not infer access just because a service name appears in a conversation.

## Connect an account

Choose the relevant plugin and follow its connection/sign-in flow. Complete authorization in the supplied browser or dialog. Select or permit its use in the intended conversation when requested. Connecting an account, granting conversation read access and approving an action are separate steps. An installed plugin with no working account connection cannot read that account.

For an account task, ask the assistant to discover the relevant service tools and use actual results. Reconnect if authorization has expired or been revoked. Revoking access prevents future use but cannot undo previously completed external actions. Removing an account from one chat does not necessarily disconnect it everywhere.

A focused plugin search loads only matching action schemas. It also supplies a bounded, schema-free index of actions in those connected plugins, with a count and completeness indicator. A search-only selection does not mean the entire plugin only supports search. Other actions must be loaded explicitly and still follow account scopes, conversation access and action approvals. Discovery does not execute those actions.

In local OpenAI-compatible Work runs, discovered action parameters are returned as data and the assistant calls them through a fixed invoke_tool interface. This keeps the callable tool definitions stable for prompt cache reuse. An action must belong to the run's captured plugin catalog and be explicitly loaded; current host validation, account access and approvals still apply. Chat, Bot and other protocols keep their existing loading interface.

The built-in Gmail connector supports account lookup, message search and reading, plus sending when separately authorized. It currently has no tools to create Gmail filters, archive mail or mark messages read. Connecting Gmail does not provide a signed-in Gmail browser session. Such unsupported settings actions may require the Gmail website and a separate browser sign-in; do not assume an OAuth connection grants browser cookies or additional Gmail permissions.

## Add custom tools

Use the MCP tab to configure a supported server, transport and authentication. Only use commands/endpoints you intend to trust. A server can expose tools and resources; their availability does not grant permission to execute a consequential action. Protect credentials and do not paste them into ordinary chat or bundled documentation.

## Use skills

The Skills tab manages installed procedural guidance and the skills library. Select a relevant skill or ask the assistant to find one. A skill can provide instructions and resources for a task; it does not create a missing account connection or override denied tool permissions. Reading a skill is different from executing the programs or actions it describes.
