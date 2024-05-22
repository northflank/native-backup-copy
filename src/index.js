import _ from 'lodash';
import { config } from 'dotenv';
import { ApiClient, ApiClientInMemoryContextProvider } from '@northflank/js-client';

config();

const NF_HOST = process.env.NF_HOST;
const NF_API_TOKEN = process.env.NF_API_TOKEN;
const NF_PROJECT_ID = process.env.NF_PROJECT_ID;
const NF_SOURCE_ADDON_ID = process.env.NF_SOURCE_ADDON_ID;
const NF_TARGET_ADDON_ID = process.env.NF_TARGET_ADDON_ID;

const ADDON_WAIT_DURATION_INPUT = process.env.ADDON_WAIT_DURATION || '3';
const BACKUP_WAIT_DURATION_INPUT = process.env.BACKUP_WAIT_DURATION || '5';

console.log({
  NF_PROJECT_ID,
  NF_SOURCE_ADDON_ID,
  NF_TARGET_ADDON_ID,

  ADDON_WAIT_DURATION: ADDON_WAIT_DURATION_INPUT,
  BACKUP_WAIT_DURATION: BACKUP_WAIT_DURATION_INPUT
});

export async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const timestamp = (new Date()).valueOf();

const checkAddon = async ({ apiClient, addonId, durationInMinutes = 5}) => {
  const startTime = new Date().valueOf();
  let addonRunning = false
  let currentAddonObject;
  
  console.log(`Checking addon ${addonId}`);
  
  do {
    currentAddonObject = await apiClient.get.addon({
      parameters: {
        projectId: NF_PROJECT_ID, addonId
      }
    });
    
    if (!currentAddonObject.data?.id)
      throw new Error(`Addon status for ${addonId} could not be checked.`);

    if (currentAddonObject.data.status === 'running') addonRunning = true;
    
    if (!addonRunning) {
      const currentTime = new Date().valueOf();
      if (currentTime - startTime > durationInMinutes * 60 * 1000)
        throw new Error(`Exceeded maximum wait time for addon ${addonId} to go into running (Currently ${currentAddonObject.data.status}).`);

      await sleep(30000);
    }
  } while (!addonRunning);
  
  console.log(`Addon ${addonId} is in state running`);
  
  return { backup: currentAddonObject };
}

const checkAddonBackup = async ({ apiClient, backup, durationInMinutes = 5 }) => {
  const startTime = new Date().valueOf();
  const backupCompletedStatuses = ['completed'];
  const backupTerminatedStatuses = ['aborting' | 'aborted' | 'failed' | 'not-supported'];
  let backupConcluded = false
  let currentBackupObject;

  console.log(`Waiting for backup ${backup.data.id} to complete`);
  
  do {
    await sleep(30000);
    currentBackupObject = await apiClient.get.addon.backup({
      parameters: {
        projectId: NF_PROJECT_ID, addonId: NF_TARGET_ADDON_ID, backupId: backup.data.id,
      }
    });

    if (!currentBackupObject.data?.id)
      throw new Error('Back up status check failed.');

    if ([...backupCompletedStatuses, ...backupTerminatedStatuses].includes(currentBackupObject.data.status)) backupConcluded = true;

    const currentTime = new Date().valueOf();
    if (currentTime - startTime > durationInMinutes * 60 * 1000) 
      throw new Error(`Exceeded maximum wait time for backup to succeed.`);
  } while (!backupConcluded);

  if (!backupCompletedStatuses.includes(currentBackupObject.data.status))
    throw new Error('Back up could not be successfully imported.');

  console.log(`Backup ${backup} completed`);
  
  return { backup: currentBackupObject };
}

(async () => {
  const ADDON_WAIT_DURATION = parseInt(ADDON_WAIT_DURATION_INPUT, 10);
  const BACKUP_WAIT_DURATION = parseInt(BACKUP_WAIT_DURATION_INPUT, 10);

  if(!_.isInteger(ADDON_WAIT_DURATION)) throw new Error(`${ADDON_WAIT_DURATION} not valid interval`);
  if(!_.isInteger(BACKUP_WAIT_DURATION)) throw new Error(`${BACKUP_WAIT_DURATION} not valid interval`);


  // Create context to store credentials.
  const contextProvider = new ApiClientInMemoryContextProvider();
  await contextProvider.addContext({
    name: 'backup-content',
    token: NF_API_TOKEN,
    host: NF_HOST
  });
  
  const apiClient = new ApiClient(contextProvider);

  const project = (await apiClient.get.project({ parameters: { projectId: NF_PROJECT_ID } }));
  if (!project) {
    throw new Error('Project not found');
  }
  
  await checkAddon({ apiClient, addonId: NF_SOURCE_ADDON_ID, durationInMinutes: 3 });

  await checkAddon({ apiClient, addonId: NF_TARGET_ADDON_ID, durationInMinutes: 3 });

  const response = (await apiClient.get.addon.backups({ parameters: { projectId: NF_PROJECT_ID, addonId: NF_SOURCE_ADDON_ID} }));
  
  const relevantBackups = response.data.backups.filter(b => b.status === 'completed' && b.config?.source?.type === 'sameAddon');
  const latestDumpBackup = relevantBackups[0];

  if (latestDumpBackup) {
    const backupLinkResponse = await apiClient.get.addon.backup.download({
      parameters: {
        projectId: NF_PROJECT_ID, addonId: NF_SOURCE_ADDON_ID, backupId: latestDumpBackup.id,
      }
    });
    if (!backupLinkResponse.data?.downloadLink) {
      throw new Error(`Download link could not be fetched.`);
    }

    const newBackup = await apiClient.import.addon.backup({
      parameters: {
        projectId: NF_PROJECT_ID, addonId: NF_TARGET_ADDON_ID, backupId: latestDumpBackup.id,
      },
      data: {
        "name": `cron-job-import-${timestamp}`,
        "importUrl": backupLinkResponse.data.downloadLink
      }
    });
    
    if (!newBackup?.data?.id) {
      throw new Error('Back up could not be initiated from download link.')
    }
    
    await checkAddonBackup({ apiClient, backup: newBackup, durationInMinutes: 15 })
   
    await apiClient.restore.addon.backup({
      parameters: {
        projectId: NF_PROJECT_ID, addonId: NF_TARGET_ADDON_ID, backupId: newBackup.data.id,
      }
    });

    console.log('Initiated restore');
  }
})();