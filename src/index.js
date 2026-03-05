import core from '@actions/core';
import github from '@actions/github';
import axios from 'axios';

import {getConfig, getClient} from './utils.js';
import {
  searchDiscussionsQuery,
  addDiscussionCommentQuery,
  getLabelQuery,
  createLabelQuery,
  getDiscussionLabelsQuery,
  addLabelsToLabelableQuery,
  removeLabelsFromLabelableQuery,
  lockLockableQuery
} from './data.js';


async function validateSubscription() {
  const repoPrivate = github.context?.payload?.repository?.private;
  const upstream = 'dessant/lock-threads';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';
  core.info('');
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m');
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
  core.info('');
  if (repoPrivate === false) return;
  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body = { action: action || '' };
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body, { timeout: 3000 }
    );
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 403) {
      core.error(`\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`);
      core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}

async function run() {
  try {
    await validateSubscription();
    const config = getConfig();
    const client = getClient(config['github-token']);

    const app = new App(config, client);
    await app.lockThreads();
  } catch (err) {
    core.setFailed(err.message);
  }
}

class App {
  constructor(config, client) {
    this.config = config;
    this.client = client;
  }

  async lockThreads() {
    const processOnly = this.config['process-only'];
    const logOutput = this.config['log-output'];

    const threadTypes = processOnly || ['issue', 'pr', 'discussion'];
    for (const item of threadTypes) {
      const threads = await this.lock(item);

      core.debug(`Setting output (${item}s)`);
      if (threads.length) {
        core.setOutput(`${item}s`, JSON.stringify(threads));

        if (logOutput) {
          core.info(`Output (${item}s):`);
          core.info(JSON.stringify(threads, null, 2));
        }
      } else {
        core.setOutput(`${item}s`, '');
      }
    }
  }

  async lock(threadType) {
    const {owner, repo} = github.context.repo;

    const addLabels = this.config[`add-${threadType}-labels`];
    const removeLabels = this.config[`remove-${threadType}-labels`];
    const comment = this.config[`${threadType}-comment`];
    const lockReason = this.config[`${threadType}-lock-reason`];

    const threads = [];

    const results = await this.search(threadType);

    for (const result of results) {
      const thread =
        threadType === 'discussion'
          ? {owner, repo, discussion_number: result.number}
          : {owner, repo, issue_number: result.number};
      const threadNumber = thread.discussion_number || thread.issue_number;
      const discussionId = result.id;

      if (comment) {
        core.debug(`Commenting (${threadType}: ${threadNumber})`);

        if (threadType === 'discussion') {
          await this.client.graphql(addDiscussionCommentQuery, {
            discussionId,
            body: comment
          });
        } else {
          try {
            await this.client.rest.issues.createComment({
              ...thread,
              body: comment
            });
          } catch (err) {
            if (!/cannot be modified.*discussion/i.test(err.message)) {
              throw err;
            }
          }
        }
      }

      if (addLabels || removeLabels) {
        let currentLabels;
        if (threadType === 'discussion') {
          ({
            repository: {
              discussion: {
                labels: {nodes: currentLabels}
              }
            }
          } = await this.client.graphql(getDiscussionLabelsQuery, {
            owner,
            repo,
            discussion: thread.discussion_number
          }));
        } else {
          ({
            data: {labels: currentLabels}
          } = await this.client.rest.issues.get({...thread}));
        }

        if (addLabels) {
          const currentLabelNames = currentLabels.map(label => label.name);
          const newLabels = addLabels.filter(
            label => !currentLabelNames.includes(label)
          );

          if (newLabels.length) {
            core.debug(`Labeling (${threadType}: ${threadNumber})`);

            if (threadType === 'discussion') {
              const labels = [];
              for (const labelName of newLabels) {
                let {
                  repository: {label}
                } = await this.client.graphql(getLabelQuery, {
                  owner,
                  repo,
                  label: labelName
                });

                if (!label) {
                  ({
                    createLabel: {label}
                  } = await this.client.graphql(createLabelQuery, {
                    repositoryId: github.context.payload.repository.node_id,
                    name: labelName,
                    color: 'ffffff',
                    headers: {
                      Accept: 'application/vnd.github.bane-preview+json'
                    }
                  }));
                }

                labels.push(label);
              }

              await this.client.graphql(addLabelsToLabelableQuery, {
                labelableId: discussionId,
                labelIds: labels.map(label => label.id)
              });
            } else {
              await this.client.rest.issues.addLabels({
                ...thread,
                labels: newLabels
              });
            }
          }
        }

        if (removeLabels) {
          const matchingLabels = currentLabels.filter(label =>
            removeLabels.includes(label.name)
          );

          if (matchingLabels.length) {
            core.debug(`Unlabeling (${threadType}: ${threadNumber})`);

            if (threadType === 'discussion') {
              await this.client.graphql(removeLabelsFromLabelableQuery, {
                labelableId: discussionId,
                labelIds: matchingLabels.map(label => label.id)
              });
            } else {
              for (const label of matchingLabels) {
                await this.client.rest.issues.removeLabel({
                  ...thread,
                  name: label.name
                });
              }
            }
          }
        }
      }

      core.debug(`Locking (${threadType}: ${threadNumber})`);

      if (threadType === 'discussion') {
        await this.client.graphql(lockLockableQuery, {
          lockableId: discussionId
        });
      } else {
        const params = {...thread};

        if (lockReason) {
          params.lock_reason = lockReason;
        }

        await this.client.rest.issues.lock(params);
      }

      threads.push(thread);
    }

    return threads;
  }

  async search(threadType) {
    const {owner, repo} = github.context.repo;
    const updatedTime = this.getUpdatedTimestamp(
      this.config[`${threadType}-inactive-days`]
    );
    let query = `repo:${owner}/${repo} updated:<${updatedTime} is:closed is:unlocked`;

    const includeAnyLabels = this.config[`include-any-${threadType}-labels`];
    const includeAllLabels = this.config[`include-all-${threadType}-labels`];

    if (includeAllLabels) {
      query += ` ${includeAllLabels
        .map(label => `label:"${label}"`)
        .join(' ')}`;
    } else if (includeAnyLabels) {
      query += ` label:${includeAnyLabels
        .map(label => `"${label}"`)
        .join(',')}`;
    }

    const excludeAnyLabels = this.config[`exclude-any-${threadType}-labels`];
    if (excludeAnyLabels) {
      query += ` -label:${excludeAnyLabels
        .map(label => `"${label}"`)
        .join(',')}`;
    }

    const excludeCreatedQuery = this.getFilterByDateQuery({
      threadType,
      qualifier: 'created'
    });
    if (excludeCreatedQuery) {
      query += ` ${excludeCreatedQuery}`;
    }

    const excludeClosedQuery = this.getFilterByDateQuery({
      threadType,
      qualifier: 'closed'
    });
    if (excludeClosedQuery) {
      query += ` ${excludeClosedQuery}`;
    }

    if (threadType === 'issue') {
      query += ' is:issue';
    } else if (threadType === 'pr') {
      query += ' is:pr';
    }

    core.debug(`Searching (${threadType}s)`);

    let results;
    if (threadType === 'discussion') {
      ({
        search: {nodes: results}
      } = await this.client.graphql(searchDiscussionsQuery, {q: query}));
    } else {
      ({
        data: {items: results}
      } = await this.client.rest.search.issuesAndPullRequests({
        q: query,
        sort: 'updated',
        order: 'desc',
        per_page: 50
      }));

      // results may include locked threads
      results = results.filter(item => !item.locked);
    }

    return results;
  }

  getFilterByDateQuery({threadType, qualifier = 'created'} = {}) {
    const beforeDate = this.config[`exclude-${threadType}-${qualifier}-before`];
    const afterDate = this.config[`exclude-${threadType}-${qualifier}-after`];
    const betweenDates =
      this.config[`exclude-${threadType}-${qualifier}-between`];

    if (betweenDates) {
      return `-${qualifier}:${betweenDates
        .map(date => this.getISOTimestamp(date))
        .join('..')}`;
    } else if (beforeDate && afterDate) {
      return `${qualifier}:${this.getISOTimestamp(
        beforeDate
      )}..${this.getISOTimestamp(afterDate)}`;
    } else if (beforeDate) {
      return `${qualifier}:>${this.getISOTimestamp(beforeDate)}`;
    } else if (afterDate) {
      return `${qualifier}:<${this.getISOTimestamp(afterDate)}`;
    }
  }

  getUpdatedTimestamp(days) {
    const ttl = days * 24 * 60 * 60 * 1000;
    const date = new Date(new Date() - ttl);
    return this.getISOTimestamp(date);
  }

  getISOTimestamp(date) {
    return date.toISOString().split('.')[0] + 'Z';
  }
}

run();
