// The public vocabulary (t755, recall spec Sections 2.1, 2.2, and 7): the one file that says which names may stand in a class P field of a
// captured step or frame. Anything else becomes `<literal>`, so a private script, host, package, or server name never reaches a pooled field.
//
// A simple list on purpose, and it fails closed: a missing public name costs a `<literal>`, while a wrongly listed one costs a leak. The D11 and
// D13 vocabulary spec owns the final list and wins on what may leave the machine. This repository is public, so nothing private is ever added here.

/** What every name outside this file becomes. */
export const LITERAL = '<literal>';

export const REPO_SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type RepoSize = (typeof REPO_SIZES)[number];
/** A stored size bucket: null is a size that could not be read, and undefined is a value that is not one. */
export const asRepoSize = (value: unknown): RepoSize | null | undefined => (value === null ? null : REPO_SIZES.find((size) => size === value));

/** File extension to language: the stack's language mix. */
export const LANGUAGE_OF_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['ts', 'typescript'],
  ['tsx', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['js', 'javascript'],
  ['jsx', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['py', 'python'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['rb', 'ruby'],
  ['php', 'php'],
  ['cs', 'csharp'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['hpp', 'cpp'],
  ['swift', 'swift'],
  ['scala', 'scala'],
  ['sh', 'shell'],
  ['ps1', 'powershell'],
  ['sql', 'sql'],
  ['astro', 'astro'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['css', 'css'],
  ['html', 'html'],
]);
export const LANGUAGES: ReadonlySet<string> = new Set(LANGUAGE_OF_EXTENSION.values());

/** A touched file's base name to the framework it shows. */
export const FRAMEWORK_OF_FILE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^pom\.xml$/, 'maven'],
  [/^build\.gradle(\.kts)?$/, 'gradle'],
  [/^vite\.config\.[a-z]+$/, 'vite'],
  [/^vitest\.config\.[a-z]+$/, 'vitest'],
  [/^astro\.config\.[a-z]+$/, 'astro'],
  [/^next\.config\.[a-z]+$/, 'next'],
  [/^nuxt\.config\.[a-z]+$/, 'nuxt'],
  [/^svelte\.config\.[a-z]+$/, 'svelte'],
  [/^angular\.json$/, 'angular'],
  [/^tailwind\.config\.[a-z]+$/, 'tailwind'],
  [/^playwright\.config\.[a-z]+$/, 'playwright'],
  [/^jest\.config\.[a-z]+$/, 'jest'],
  [/^wrangler\.(toml|jsonc?)$/, 'cloudflare-workers'],
  [/^Cargo\.toml$/, 'cargo'],
  [/^go\.mod$/, 'go-modules'],
  [/^Dockerfile$/, 'docker'],
  [/^manage\.py$/, 'django'],
  [/^Gemfile$/, 'bundler'],
  [/\.tf$/, 'terraform'],
  [/\.csproj$/, 'dotnet'],
];

/** A program a shell call ran to the framework it shows. */
export const FRAMEWORK_OF_PROGRAM: ReadonlyMap<string, string> = new Map([
  ['mvn', 'maven'],
  ['mvnw', 'maven'],
  ['gradle', 'gradle'],
  ['gradlew', 'gradle'],
  ['vite', 'vite'],
  ['vitest', 'vitest'],
  ['astro', 'astro'],
  ['playwright', 'playwright'],
  ['jest', 'jest'],
  ['wrangler', 'cloudflare-workers'],
  ['cargo', 'cargo'],
  ['docker', 'docker'],
  ['kubectl', 'kubernetes'],
  ['helm', 'kubernetes'],
  ['terraform', 'terraform'],
  ['dotnet', 'dotnet'],
  ['rails', 'rails'],
]);
export const FRAMEWORKS: ReadonlySet<string> = new Set([...FRAMEWORK_OF_FILE.map(([, name]) => name), ...FRAMEWORK_OF_PROGRAM.values()]);

const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
// Published shapes only, each part a version or a word from the closed list, so a gateway or fine-tune name under a known family fails closed.
const MODEL_VERSION = '[a-z]?\\d[\\d.]*[a-z]?';
const MODEL_WORD = 'mini|nano|pro|max|lite|turbo|flash|ultra|large|medium|small|tiny|high|low|fast|code|codex|coder|chat|reasoner|thinking|exp|preview|latest|instant';
const CLAUDE_TIER = 'opus|sonnet|haiku|fable';
const MODEL = new RegExp(
  [
    `^claude-(?:${CLAUDE_TIER})(?:-\\d[\\d.]*)*$`,
    `^claude-\\d[\\d.]*(?:-\\d+)*(?:-(?:${CLAUDE_TIER}|instant)(?:-\\d+)*)?$`,
    `^(?:gpt|o[134]|gemini|codex|composer|cursor|grok|deepseek|llama|mistral|qwen|kimi|glm)(?:-?${MODEL_VERSION})?(?:-(?:${MODEL_VERSION}|${MODEL_WORD}))*$`,
    '^(?:auto|default)$',
  ].join('|'),
);
// A suffix is digits or a release word, so a private build tag fails closed, as a private name does in `MODEL`.
const VERSION = /^\d+(?:\.\d+){0,3}(?:[-+.](?:\d+|(?:alpha|beta|rc|dev|canary|nightly|next)\d*))*$/;
/** A name this long is not one of these: it is text someone pasted. */
const NAME_MAX = 64;

const orLiteral = (value: string | null, isPublic: (value: string) => boolean): string | null => (value === null || (value.length <= NAME_MAX && isPublic(value)) ? value : LITERAL);

export const publicEffort = (value: string | null): string | null => orLiteral(value, (effort) => EFFORTS.has(effort));
export const publicModel = (value: string | null): string | null => orLiteral(value, (model) => MODEL.test(model));
export const publicVersion = (value: string | null): string | null => orLiteral(value, (version) => VERSION.test(version));

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter((word) => word !== ''));

/** Programs whose short flags are commonly bundled, as in `rm -rf`. Elsewhere a short lowercase run is more likely a value joined to its flag, as in `mysql -pabc`. */
export const BUNDLING_PROGRAMS: ReadonlySet<string> = new Set(
  words(`
    rm cp mv ls mkdir chmod chown ln touch tar zip unzip gzip gunzip grep rg sed awk sort uniq wc cut head tail du df ps kill
    xargs git curl wget rsync diff tr bash sh zsh docker
  `),
);

/** Programs anyone can install or a system ships. A private script or binary is not here, so it reads as the literal. */
export const PUBLIC_PROGRAMS: ReadonlySet<string> = new Set([
  ...FRAMEWORK_OF_PROGRAM.keys(),
  ...words(`
    git gh glab svn hg
    for foreach while until case select break continue exit return read shift throw param trap wait
    od basename dirname cygpath cmp fold paste seq rev sum
    get-date out-string out-null out-file start-sleep get-ciminstance import-module format-table format-list convertfrom-json convertto-json resolve-path
    tee-object get-member join-path split-path start-threadjob start-job receive-job wait-job push-location pop-location set-location
    npm npx pnpm yarn bun deno node nvm tsc eslint prettier biome turbo nx webpack rollup esbuild tsx
    python python3 py pip pip3 pipx uv uvx poetry pytest ruff mypy black tox conda
    java javac jar kotlin scala sbt go gofmt rustc rustup ruby gem bundle rake php composer perl lua swift nuget make cmake just gcc clang brew
    docker-compose podman k3d kind minikube aws az gcloud flyctl vercel netlify stripe psql mysql sqlite3 redis-cli curl wget ssh scp rsync
    ls dir cat type head tail less more wc sort uniq cut tr sed awk grep rg find fd tree du df stat file touch mkdir rmdir rm cp mv ln chmod chown pwd cd pushd popd
    echo printf test true false sleep date which where whoami hostname export set unset source tee xargs diff patch tar zip unzip gzip gunzip jq yq sha256sum md5sum base64
    ps kill killall pkill pgrep top lsof netstat taskkill tasklist bash sh zsh dash fish pwsh powershell cmd code cursor claude codex gemini oars
    get-childitem get-content set-content add-content get-item set-item new-item remove-item copy-item move-item rename-item test-path select-string select-object where-object foreach-object sort-object measure-object get-process stop-process start-process write-output write-host out-file get-command set-location get-location invoke-webrequest invoke-restmethod
  `),
]);

/** The subcommands of a public program. Only a program whose subcommands are its own public interface is here: a `just` recipe or a `make` target belongs to the repository. */
export const PUBLIC_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries({
    git: 'add am apply bisect blame branch checkout cherry-pick clean clone commit config describe diff fetch format-patch gc grep init log ls-files ls-remote ls-tree merge merge-base mv pull push rebase reflog remote reset restore revert rev-list rev-parse rm shortlog show stash status submodule switch symbolic-ref tag update-index worktree',
    gh: 'alias api auth browse cache codespace config extension gist issue label pr release repo run search secret ssh-key status variable workflow',
    npm: 'access audit ci config create dedupe exec explain fund help init install link list login logout ls outdated pack prune publish rebuild root run run-script test uninstall unlink update version view whoami',
    pnpm: 'add audit create dlx exec init install link list outdated publish remove run store test update why',
    yarn: 'add audit create dlx exec init install link list outdated remove run test upgrade why',
    bun: 'add build create init install link pm publish remove run test update x',
    deno: 'add bench check compile fmt info init install lint publish run task test',
    pip: 'cache check config download freeze hash index install list show uninstall wheel',
    pip3: 'cache check config download freeze hash index install list show uninstall wheel',
    pipx: 'ensurepath inject install list reinstall run uninstall upgrade',
    uv: 'add build cache init lock pip publish python remove run sync tool tree venv',
    poetry: 'add build check config export init install lock publish remove run shell show update',
    go: 'bug build clean doc env fix fmt generate get install list mod run test tool version vet work',
    cargo: 'add bench build check clean clippy doc fetch fix fmt init install metrics new publish remove run search test tree uninstall update',
    rustup: 'check component default install override show target toolchain update',
    dotnet: 'add build clean format list new nuget pack publish remove restore run sln test tool',
    mvn: 'clean compile dependency:tree deploy install package site test test-compile validate verify',
    mvnw: 'clean compile dependency:tree deploy install package site test test-compile validate verify',
    gradle: 'assemble bootRun build check clean dependencies jar tasks test wrapper',
    gradlew: 'assemble bootRun build check clean dependencies jar tasks test wrapper',
    gem: 'build environment install list outdated push search uninstall update',
    bundle: 'add check config exec init install list lock outdated remove show update',
    brew: 'cask cleanup doctor info install leaves link list outdated search services tap uninstall unlink update upgrade',
    docker: 'attach build buildx commit compose context cp create diff events exec export history image images import info inspect kill load login logout logs network node pause port ps pull push rename restart rm rmi run save search secret service stack start stats stop swarm system tag top unpause update version volume wait',
    'docker-compose': 'build config create down events exec images kill logs pause port ps pull push restart rm run start stop top unpause up version',
    kubectl: 'annotate api-resources apply attach auth autoscale cluster-info config cordon cp create debug delete describe diff drain edit events exec explain expose get kustomize label logs patch port-forward proxy replace rollout run scale set taint top uncordon version wait',
    helm: 'create dependency diff get history install lint list package pull push repo rollback search show status template test uninstall upgrade verify version',
    terraform: 'apply console destroy fmt force-unlock get graph import init output plan providers refresh show state taint test untaint validate version workspace',
    aws: 'cloudformation cloudfront configure dynamodb ec2 ecr ecs eks iam kms lambda logs rds route53 s3 s3api secretsmanager sns sqs ssm sts',
    gcloud: 'app auth builds compute config container functions iam projects run secrets services sql storage',
    az: 'account acr aks group keyvault login network storage vm webapp',
    wrangler: 'd1 deploy dev init kv login logout pages queues r2 secret tail types versions whoami',
    vitest: 'bench dev related run typecheck watch',
    playwright: 'codegen install show-report test',
    astro: 'add build check dev preview sync',
    vite: 'build dev optimize preview',
    oars: 'allow api audit config deposit derive doctor help init install login measure pull push recall sessions status verify',
    claude: 'agents config doctor install mcp plugin setup-token update',
  }).map(([program, list]) => [program, words(list)]),
);

/** Flag names of common public programs. A flag name on another program can be a private script's, so an unlisted name reads as the literal. */
export const PUBLIC_FLAGS: ReadonlySet<string> = words(`
  --all --allow-empty --amend --author --base --body --branch --build --cached --check --chdir --ci --clean --color --config --context --count --coverage
  --create --cwd --debug --decorate --delete --depth --detach --dir --directory --dry-run --edit --env --exclude --exit-code --fail --file --filter --fix
  --follow --force --force-with-lease --format --from --global --graph --hard --head --help --ignore-case --include --info --init --interactive --json --jq
  --label --limit --line-number --list --lockfile-only --message --method --mixed --name --name-only --name-status --namespace --no-cache --no-color --no-edit
  --no-ff --no-install --no-pager --no-verify --no-save --noEmit --numstat --oneline --only --output --package --parents --path --porcelain --port --prefix
  --production --project --prune --pretty --quiet --recursive --reporter --repo --reverse --rm --run --save --save-dev --set-upstream --short --show-current
  --silent --since --skip-tests --soft --stat --state --tags --target --template --title --token --until --update --user --verbose --version --watch --web --workspace --yes
  --abbrev-ref --abort --contains --continue --ff-only --first-parent --ignored --is-ancestor --is-inside-work-tree --max-count --merged --no-commit
  --no-merges --no-rebase --no-stat --others --remotes --show-toplevel --staged --stdin
  -AllMatches -Append -Compress -Confirm -Context -Descending -Directory -Encoding -Exclude -ExpandProperty -File -First -ItemType -Last -Milliseconds -Name
  -NoNewline -Property -Seconds -SimpleMatch -Skip -TotalCount -Unique -Value -Wait
  -Command -Depth -ErrorAction -ExecutionPolicy -Filter -Force -Include -LiteralPath -NoLogo -NoProfile -NonInteractive -Path -Pattern -Raw -Recurse -Tail
`);

/** Hosts that say nothing about who asked. Matched whole: `acme.github.io` names a customer even though `github.io` is public. */
export const PUBLIC_HOSTS: ReadonlySet<string> = words(`
  github.com raw.githubusercontent.com gist.github.com docs.github.com api.github.com gitlab.com bitbucket.org stackoverflow.com superuser.com serverfault.com
  en.wikipedia.org developer.mozilla.org npmjs.com www.npmjs.com registry.npmjs.org pypi.org docs.python.org crates.io docs.rs pkg.go.dev go.dev rubygems.org
  docs.oracle.com spring.io docs.spring.io maven.apache.org kubernetes.io docs.docker.com hub.docker.com nodejs.org react.dev vite.dev vitejs.dev typescriptlang.org
  www.typescriptlang.org docs.astro.build developers.cloudflare.com docs.stripe.com stripe.com docs.anthropic.com docs.claude.com code.claude.com learn.microsoft.com
  docs.aws.amazon.com cloud.google.com platform.openai.com arxiv.org medium.com dev.to news.ycombinator.com reddit.com www.reddit.com youtube.com www.youtube.com
`);

/** MCP servers published for anyone to install. A server someone named themselves can name their company, so it reads as the literal. */
export const PUBLIC_MCP_SERVERS: ReadonlySet<string> = words(`
  claude-in-chrome playwright puppeteer github gitlab filesystem fetch memory sequential-thinking context7 sentry
  linear notion slack postgres sqlite stripe cloudflare supabase vercel figma atlassian exa tavily brave-search oars oars-sessions
`);

/** Skills published for anyone to install. */
export const PUBLIC_SKILLS: ReadonlySet<string> = words(`
  pdf docx xlsx pptx skill-creator frontend-design webapp-testing mcp-builder canvas-design algorithmic-art theme-factory brand-guidelines internal-comms slack-gif-creator web-artifacts-builder
  commit review code-review compact init schedule loop simplify security-review debug
`);

/** Packages a public registry serves and many projects use. No registry is asked at capture, so anything else reads as the literal, including a real public package missing here. */
export const PUBLIC_PACKAGES: ReadonlySet<string> = words(`
  typescript vitest jest eslint prettier vite astro react react-dom next vue svelte express fastify lodash axios zod tsx esbuild webpack rollup turbo pnpm yarn wrangler playwright @playwright/test
  @types/node @types/react @types/react-dom @anthropic-ai/sdk @anthropic-ai/claude-code @modelcontextprotocol/sdk @modelcontextprotocol/inspector tailwindcss postcss autoprefixer nodemon dotenv
  requests numpy pandas scipy flask django fastapi uvicorn pytest ruff mypy black httpx pydantic anthropic openai pillow pyyaml beautifulsoup4 boto3 setuptools wheel pip uv
  serde tokio clap anyhow thiserror reqwest rails rake bundler
`);

const REGISTRY_VERSION = /^[~^<>=!]*v?\d+(?:\.(?:\d+|x|\*))*(?:[-+][0-9A-Za-z.+-]*)?$/;
const MCP_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export const isRegistryVersion = (version: string): boolean => version.length <= NAME_MAX && REGISTRY_VERSION.test(version);
export const isMcpToolName = (tool: string): boolean => MCP_TOOL_NAME.test(tool);
