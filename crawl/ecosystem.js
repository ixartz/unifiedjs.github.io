var fs = require('fs').promises
var path = require('path')
var {promisify} = require('util')
var hostedGitInfo = require('hosted-git-info')
var randomUseragent = require('random-useragent')
var trough = require('trough')
var chalk = require('chalk')
var fetch = require('node-fetch')
var pAll = require('p-all')

require('dotenv').config()

var ghToken = process.env.GH_TOKEN
var npmToken = process.env.NPM_TOKEN

if (!ghToken || !npmToken) {
  console.warn('Cannot crawl ecosystem without GH or npm tokens')
  /* eslint-disable-next-line unicorn/no-process-exit */
  process.exit()
}

var topics = require('../generate/util/constant-topic')
var orgs = require('../generate/util/constant-collective')

var outpath = path.join('data')
var readmePath = path.join(outpath, 'readme')
var metaPath = path.join(outpath, 'meta.json')
var projectsPath = path.join(outpath, 'projects.json')
var packagesPath = path.join(outpath, 'packages.json')
var releasesPath = path.join(outpath, 'releases.json')

var concurrency = {concurrency: 1}

var hawkgirl = 'application/vnd.github.hawkgirl-preview+json'
var ghEndpoint = 'https://api.github.com/graphql'
var npmsEndpoint = 'https://api.npms.io/v2/package'
var bundlePhobiaEndpoint = 'https://bundlephobia.com/api/size'
var npmDownloadsEndpoint = 'https://api.npmjs.org/downloads'

var topicPipeline = promisify(trough().use(searchTopic).run)
var orgPipeline = promisify(trough().use(searchOrg).run)
var repoPipeline = promisify(trough().use(crawlRepo).use(getReleases).run)
var pkgPipeline = promisify(
  trough()
    .use(getManifest)
    .use(getPackage)
    .use(getReadme)
    .use(getDownloads)
    .use(getSize).run
)

var main = promisify(
  trough()
    .use(findProjectsByTopic)
    .use(findProjectsInOrganizations)
    .use(findRepositories)
    .use(findPackages)
    .use(writeResults)
    .use(writeReadmes).run
)

main({
  ghToken,
  npmToken,
  repos: [],
  topics: topics,
  orgs: orgs
}).then(
  (result) => {
    console.log(
      chalk.green('✓') + ' done (%d packages, %d projects, %d readmes)',
      result.packages.length,
      result.projects.length,
      result.readmes.length
    )
  },
  (error) => {
    console.log(chalk.red('✖') + ' error')
    throw error
  }
)

async function findProjectsByTopic(ctx) {
  var {topics, repos} = ctx

  var results = await pAll(
    topics.map((topic) => () => topicPipeline({...ctx, topic})),
    concurrency
  )

  return {...ctx, repos: repos.concat(results.flatMap((d) => d.matches))}
}

async function findProjectsInOrganizations(ctx) {
  var {orgs, repos} = ctx

  var results = await pAll(
    orgs.map((org) => () => orgPipeline({...ctx, org})),
    concurrency
  )

  return {...ctx, repos: repos.concat(results.flatMap((d) => d.matches))}
}

async function findRepositories(ctx) {
  var {repos} = ctx

  repos = repos.filter((d, i, data) => data.indexOf(d) === i)

  var results = await pAll(
    repos.map((repo) => () => repoPipeline({...ctx, repo})),
    concurrency
  )

  return {
    ...ctx,
    repos,
    projects: results.map((d) => d.project),
    releases: results.flatMap((d) => d.releases)
  }
}

async function findPackages(ctx) {
  var {projects} = ctx

  var packages = projects.flatMap((d) =>
    d.manifests.map((m) => ({manifest: m, project: d}))
  )

  var results = await pAll(
    packages.map(({manifest, project}) => () =>
      pkgPipeline({...ctx, manifest, project})
    ),
    {concurrency: 1}
  )

  var readmes = []
  var projectsWithPackages = {}
  var projectsWithPackagesIssues = {}

  packages = results
    .filter((d) => d.proper)
    .map((d) => {
      var {packageDist, readme, project, issues} = d
      var {name} = packageDist
      var {repo} = project
      var readmeName = name.replace(/^@/g, '').replace(/\//g, '-') + '.md'

      projectsWithPackages[repo] = project
      projectsWithPackagesIssues[repo] = issues

      readmes.push({name: readmeName, value: readme})

      return {...packageDist, repo, readmeName}
    })

  var meta = {size: 0, issueOpen: 0, issueClosed: 0, prOpen: 0, prClosed: 0}

  projects.forEach((d) => {
    var [owner] = d.repo.split('/')

    if (orgs.includes(owner)) {
      Object.keys(meta).forEach((key) => {
        meta[key] += d[key]
      })
    }
  })

  Object.keys(projectsWithPackagesIssues).forEach((d) => {
    projectsWithPackages[d].issues = projectsWithPackagesIssues[d]
  })

  projects = Object.values(projectsWithPackages).map((p) => ({
    ...p,
    default: undefined,
    manifests: undefined,
    size: undefined,
    issueOpen: undefined,
    issueClosed: undefined,
    prOpen: undefined,
    prClosed: undefined
  }))

  return {...ctx, readmes, projects, packages, meta}
}

async function writeResults(ctx) {
  var {projects, packages, releases, meta} = ctx

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n')
  await fs.writeFile(projectsPath, JSON.stringify(projects, null, 2) + '\n')
  await fs.writeFile(packagesPath, JSON.stringify(packages, null, 2) + '\n')
  await fs.writeFile(releasesPath, JSON.stringify(releases, null, 2) + '\n')
}

async function writeReadmes(ctx) {
  var {readmes} = ctx

  await pAll(
    readmes.map(({name, value}) => () =>
      fs.writeFile(path.join(readmePath, name), value)
    ),
    {concurrency: 10}
  )
}

async function searchTopic(ctx) {
  var {topic, ghToken} = ctx
  var matches = []
  var done = false
  var after
  var response
  var data

  var query = `
    query($query: String!, $after: String) {
      search(query: $query, type: REPOSITORY, first: 100, after: $after) {
        repositoryCount
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on Repository { nameWithOwner }
        }
      }
    }
  `

  while (!done) {
    // eslint-disable-next-line no-await-in-loop
    response = await fetch(ghEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        query,
        variables: {query: 'sort:stars-desc topic:' + topic, after}
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'bearer ' + ghToken
      }
    }).then((x) => x.json())

    data = response.data.search

    if (data.pageInfo.hasNextPage) {
      after = data.pageInfo.endCursor
    } else {
      done = true
    }

    matches = matches.concat(data.nodes.map((d) => d.nameWithOwner))
  }

  return {matches, ...ctx}
}

async function searchOrg(ctx) {
  var {org, ghToken} = ctx
  var matches = []
  var done = false
  var after
  var response
  var data

  var query = `
    query($org: String!, $after: String) {
      organization(login: $org) {
        repositories(
          first: 100
          after: $after
          isFork: false
          isLocked: false
          privacy: PUBLIC
        ) {
          pageInfo { hasNextPage endCursor }
          nodes {
            hasIssuesEnabled
            isArchived
            isDisabled
            isTemplate
            nameWithOwner
          }
        }
      }
    }
  `

  while (!done) {
    // eslint-disable-next-line no-await-in-loop
    response = await fetch(ghEndpoint, {
      method: 'POST',
      body: JSON.stringify({query, variables: {org, after}}),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'bearer ' + ghToken
      }
    }).then((x) => x.json())

    data = response.data.organization.repositories

    if (data.pageInfo.hasNextPage) {
      after = data.pageInfo.endCursor
    } else {
      done = true
    }

    matches = matches.concat(
      data.nodes
        .filter(
          (d) =>
            d.hasIssuesEnabled &&
            !d.isArchived &&
            !d.isDisabled &&
            !d.isTemplate
        )
        .map((d) => d.nameWithOwner)
    )
  }

  return {matches, ...ctx}
}

async function crawlRepo(ctx) {
  var {repo, ghToken} = ctx
  var [owner, name] = repo.split('/')

  var response = await fetch(ghEndpoint, {
    method: 'POST',
    body: JSON.stringify({
      query: `
        query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            description
            homepageUrl
            stargazers { totalCount }
            defaultBranchRef { name }
            repositoryTopics(first: 100) {
              nodes { topic { name } }
            }
            dependencyGraphManifests(withDependencies: true, first: 100) {
              nodes { filename exceedsMaxSize parseable }
            }
            diskUsage
            issueOpen: issues(states: OPEN) { totalCount }
            issueClosed: issues(states: CLOSED) { totalCount }
            prOpen: pullRequests(states: OPEN) { totalCount }
            prClosed: pullRequests(states: CLOSED) { totalCount }
            latestRelease { publishedAt }
          }
        }
      `,
      variables: {owner, name}
    }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'bearer ' + ghToken,
      Accept: hawkgirl
    }
  }).then((x) => x.json())

  // Manifests aren’t always loaded, giving errors here: print them.
  if (response.errors) {
    console.warn(
      '%s: non-exceptional errors (probably loading manifests):',
      repo,
      response.errors
    )
  }

  var data = (response.data || {}).repository || {}
  var defaultBranch = (data.defaultBranchRef || {}).name || null

  var project = {
    repo,
    description: data.description || '',
    stars: (data.stargazers || {}).totalCount || 0,
    default: defaultBranch,
    url: data.homepageUrl || null,
    topics: ((data.repositoryTopics || {}).nodes || [])
      .map((d) => d.topic.name)
      .filter(validTag)
      .filter(unique),
    manifests: ((data.dependencyGraphManifests || {}).nodes || [])
      .filter(
        (d) =>
          defaultBranch &&
          path.posix.basename(d.filename) === 'package.json' &&
          d.parseable &&
          !d.exceedsMaxSize
      )
      .map((d) => d.filename),
    // Size of repo in bytes.
    size: data.diskUsage * 1024,
    issueOpen: (data.issueOpen || {}).totalCount || 0,
    issueClosed: (data.issueClosed || {}).totalCount || 0,
    prOpen: (data.prOpen || {}).totalCount || 0,
    prClosed: (data.prClosed || {}).totalCount || 0
  }

  return {
    ...ctx,
    project,
    lastReleaseAt: new Date(
      data.latestRelease && data.latestRelease.publishedAt
    )
  }
}

async function getReleases(ctx) {
  var {repo, ghToken, lastReleaseAt} = ctx
  var [owner, name] = repo.split('/')
  var releases = []

  if (recent(lastReleaseAt)) {
    var response = await fetch(ghEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        query: `
          query($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
              releases(first: 20, orderBy: {direction: DESC, field: CREATED_AT}) {
                nodes { publishedAt tagName url description }
              }
            }
          }
        `,
        variables: {owner, name}
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'bearer ' + ghToken
      }
    }).then((x) => x.json())

    var data = (response.data || {}).repository || {}
    releases = ((data.releases || {}).nodes || [])
      .filter((d) => recent(new Date(d.publishedAt)))
      .map((d) => ({
        repo,
        published: d.publishedAt,
        tag: d.tagName,
        description: d.description
      }))
  }

  return {...ctx, releases}

  // Whether this release was in the last 60 days.
  function recent(date) {
    return date > Date.now() - 60 * 24 * 60 * 60 * 1000
  }
}

async function getManifest(ctx) {
  var {project, manifest, ghToken} = ctx
  var {repo} = project
  var [owner, name] = repo.split('/')
  var target = [project.default || 'master', manifest].join(':')
  var manifestBase = path.dirname(manifest)
  var response

  if (manifestBase === '.') {
    manifestBase = undefined
  }

  try {
    response = await fetch(ghEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        query: `
          query($owner: String!, $name: String!, $target: String!) {
            repository(owner: $owner, name: $name) {
              object(expression: $target) {
                ... on Blob { text }
              }
            }
          }
        `,
        variables: {owner, name, target}
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'bearer ' + ghToken
      }
    }).then((x) => x.json())
  } catch (error) {
    console.warn('Could not fetch manifest:', error)
  }

  var proper = true
  var pkg

  try {
    pkg = JSON.parse((response.data.repository.object || {}).text)
  } catch (_) {
    console.warn('%s#%s: could not parse manifest', repo, manifest)
    proper = false
  }

  if (pkg && !pkg.name) {
    console.warn('%s#%s: ignoring manifest without name', repo, manifest)
    proper = false
  } else if (pkg && pkg.private) {
    console.warn('%s#%s: ignoring private manifest', repo, manifest)
    proper = false
  } else if (pkg && /gatsby/i.test(pkg.name)) {
    console.warn('%s#%s: ignoring gatsby-related package', repo, manifest)
    proper = false
  }

  return {...ctx, proper, manifestBase, packageSource: pkg}
}

async function getPackage(ctx) {
  var {proper, manifest, manifestBase, project, packageSource} = ctx
  var {repo} = project
  var response
  var body

  if (!proper) {
    return
  }

  try {
    response = await fetch(
      [npmsEndpoint, encodeURIComponent(packageSource.name)].join('/')
    )
    body = await response.json()
  } catch (_) {}

  if (!body) {
    console.warn('%s#%s: could not connect to npms', repo, manifest)
    ctx.proper = false
    return
  }

  if (body.code === 'NOT_FOUND') {
    console.warn('%s#%s: could not find package (on npms)', repo, manifest)
    ctx.proper = false
    return
  }

  var name = body.collected.metadata.name || ''
  var description = body.collected.metadata.description || ''
  var keywords = body.collected.metadata.keywords || []
  var license = body.collected.metadata.license || null
  var deprecated = body.collected.metadata.deprecated
  var latest = body.collected.metadata.version || null
  var repos = body.collected.metadata.repository
  var url = (repos && repos.url) || ''
  var dependents = body.collected.npm.dependentsCount || 0
  var score = body.score.final || 0

  if (deprecated) {
    console.warn(
      '%s#%s: ignoring deprecated package: %s',
      repo,
      manifest,
      deprecated
    )
    ctx.proper = false
    return
  }

  if (!url) {
    console.warn('%s#%s: ignoring unknown repo', repo, manifest)
    ctx.proper = false
    return
  }

  var info = hostedGitInfo.fromUrl(url)

  if (!info) {
    console.warn('%s#%s: ignoring non-parsable repo: %s', repo, manifest, url)
    ctx.proper = false
    return
  }

  if (info.type !== 'github') {
    console.warn('%s#%s: ignoring non-github repo: %s', repo, manifest, url)
    ctx.proper = false
    return
  }

  var slug = [info.user, info.project].join('/')

  if (slug !== repo) {
    console.warn('%s#%s: ignoring mismatched repos: %s', repo, manifest, url)
    ctx.proper = false
    return
  }

  keywords = keywords.filter(validTag).filter(unique)

  return {
    ...ctx,
    packageDist: {
      name,
      manifestBase,
      latest,
      description,
      keywords,
      license,
      dependents,
      score
    }
  }
}

async function getReadme(ctx) {
  var {proper, manifestBase, project} = ctx
  var {repo} = project
  var [owner, name] = repo.split('/')
  var base = (project.default || 'master') + ':'
  var response

  if (!proper) {
    return
  }

  if (manifestBase) base += manifestBase + '/'

  // Instead of going through the folder and looking for the first that matches
  // `/^readme(?=\.|$)/i`, we throw the frequently used ones at GH.
  try {
    response = await fetch(ghEndpoint, {
      method: 'POST',
      body: JSON.stringify({
        query: `
          query($owner: String!, $name: String!, $umd: String!, $u: String!, $cmd: String!, $c: String!, $lmd: String!, $l: String!) {
            repository(owner: $owner, name: $name) {
              umd: object(expression: $umd) { ... on Blob { text } }
              u: object(expression: $u) { ... on Blob { text } }
              cmd: object(expression: $cmd) { ... on Blob { text } }
              c: object(expression: $c) { ... on Blob { text } }
              lmd: object(expression: $lmd) { ... on Blob { text } }
              l: object(expression: $l) { ... on Blob { text } }
            }
          }
        `,
        variables: {
          owner,
          name,
          umd: base + 'README.md',
          u: base + 'README',
          cmd: base + 'Readme.md',
          c: base + 'Readme',
          lmd: base + 'readme.md',
          l: base + 'readme'
        }
      }),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'bearer ' + ghToken
      }
    }).then((x) => x.json())
  } catch (error) {
    console.warn('Could not fetch `readme.md`:', error)
  }

  var repository = ((response || {}).data || {}).repository || {}
  var object =
    repository.umd ||
    repository.u ||
    repository.cmd ||
    repository.c ||
    repository.lmd ||
    repository.l
  var readme = (object || {}).text || ''

  if (!object) {
    console.warn('%s#%s: could not find readme', repo, base)
    ctx.proper = false
    return
  }

  if (readme.length < 20) {
    console.warn('%s#%s: ignoring package without readme', repo, base)
    ctx.proper = false
    return
  }

  ctx.readme = readme
}

async function getDownloads(ctx) {
  var {proper, packageDist} = ctx
  // See below: `npmToken = ctx.npmToken`.

  if (!proper) {
    return
  }

  var endpoint = [
    npmDownloadsEndpoint,
    'point',
    'last-month',
    packageDist.name
  ].join('/')

  var response = await fetch(endpoint, {
    // Passing an npm token recently seems to crash npm.
    // headers: {Authorization: 'Bearer ' + npmToken}
  }).then((x) => x.json())

  ctx.packageDist = {...ctx.packageDist, downloads: response.downloads}
}

async function getSize(ctx) {
  var {proper, manifest, project, packageDist} = ctx
  var {repo} = project
  var response

  if (!proper) {
    return
  }

  var endpoint =
    bundlePhobiaEndpoint +
    '?package=' +
    encodeURIComponent(packageDist.name + '@' + packageDist.latest)

  try {
    response = await fetch(endpoint, {
      headers: {'User-Agent': randomUseragent.getRandom()}
    }).then((x) => x.json())
  } catch (error) {
    console.warn('%s#%s: could not contact bundlephobia', repo, manifest, error)
    // Still “proper”.
    return
  }

  var gzip = response.gzip
  var esm = Boolean(response.hasJSModule)
  var dependencies = response.dependencyCount

  ctx.packageDist = {...ctx.packageDist, gzip, esm, dependencies}
}

function unique(d, i, data) {
  return data.indexOf(d) === i
}

function validTag(d) {
  return /^[a-zA-Z\d-]+$/.test(d)
}
