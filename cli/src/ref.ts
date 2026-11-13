// The source references `moro add` takes: the `skills` CLI's grammar.

export interface SourceRef {
  /** What the manifest records: `owner/repo` for GitHub, otherwise the git URL. */
  repo: string;
  /** A branch, tag or commit, from `#ref` or a tree URL. */
  revision?: string;
  /** A folder in the source, from a tree URL or `owner/repo/<path>`. */
  subpath?: string;
  /** A skill, from `owner/repo@skill` or `#ref@skill`. */
  skill?: string;
}

const GITHUB_TREE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+?))?\/?$/;
const GITHUB_SSH = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const GITHUB_REPO = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
/** `owner/repo`, GitHub's shorthand. */
const OWNER_REPO = "([^/:.@][^/:@]*)\\/([^/:@]+)";
const SHORTHAND = new RegExp(`^${OWNER_REPO}(?:@(.+)|\\/(.+?))?\\/?$`);
const BARE_SHORTHAND = new RegExp(`^${OWNER_REPO}$`);

export function parseRef(input: string): SourceRef {
  const hash = input.indexOf("#");
  const base = hash < 0 ? input : input.slice(0, hash);
  const [fragmentRevision, fragmentSkill] = hash < 0 ? [] : input.slice(hash + 1).split("@", 2);
  const fromFragment = {
    ...(fragmentRevision ? { revision: fragmentRevision } : {}),
    ...(fragmentSkill ? { skill: fragmentSkill } : {}),
  };

  const tree = GITHUB_TREE.exec(base);
  if (tree) {
    const [, owner, repo, revision, subpath] = tree;
    return { repo: `${owner}/${repo}`, revision: revision!, ...(subpath ? { subpath } : {}), ...fromFragment };
  }
  const github = GITHUB_REPO.exec(base) ?? GITHUB_SSH.exec(base);
  if (github) return { repo: `${github[1]}/${github[2]}`, ...fromFragment };
  const shorthand = SHORTHAND.exec(base);
  if (shorthand) {
    const [, owner, repo, skill, subpath] = shorthand;
    return {
      repo: `${owner}/${repo}`,
      ...(skill ? { skill } : {}),
      ...(subpath ? { subpath } : {}),
      ...fromFragment,
    };
  }
  return { repo: base, ...fromFragment };
}

/** The URL git clones for a manifest `repo`. */
export function cloneUrl(repo: string): string {
  return BARE_SHORTHAND.test(repo) ? `https://github.com/${repo}.git` : repo;
}
