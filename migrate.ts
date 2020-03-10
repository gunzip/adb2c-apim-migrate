// tslint:disable:no-console
import * as dotenv from "dotenv";

import {
  ApiManagementClient,
  ApiManagementModels
} from "@azure/arm-apimanagement";
import * as msGraph from "@azure/graph";
import { isNone, none, isSome, some } from "fp-ts/lib/Option";
import * as msRestAzure from "@azure/ms-rest-nodeauth";
import * as randomstring from "randomstring";
import { Either, right } from "fp-ts/lib/Either";
import { Option } from "fp-ts/lib/Option";
import { UserContract } from "@azure/arm-apimanagement/esm/models";
import { ulid } from "ulid";

dotenv.config();

//////////////////////////////////////////////////////////

const OLD_ARM_CLIENT_ID = process.env.OLD_ARM_CLIENT_ID;
const OLD_ARM_CLIENT_SECRET = process.env.OLD_ARM_CLIENT_SECRET;
const OLD_ARM_TENANT_ID = process.env.OLD_ARM_TENANT_ID;
const OLD_ARM_SUBSCRIPTION_ID = process.env.OLD_ARM_SUBSCRIPTION_ID;

const OLD_APIM_NAME = process.env.OLD_APIM_NAME;
const OLD_APIM_RG = process.env.OLD_APIM_RG;

const NEW_ARM_CLIENT_ID = process.env.NEW_ARM_CLIENT_ID;
const NEW_ARM_CLIENT_SECRET = process.env.NEW_ARM_CLIENT_SECRET;
const NEW_ARM_TENANT_ID = process.env.NEW_ARM_TENANT_ID;
const NEW_ARM_SUBSCRIPTION_ID = process.env.NEW_ARM_SUBSCRIPTION_ID;

const NEW_APIM_NAME = process.env.NEW_APIM_NAME;
const NEW_APIM_RG = process.env.NEW_APIM_RG;

const NEW_ADB2C_CLIENT_ID = process.env.NEW_ADB2C_CLIENT_ID;
const NEW_ADB2C_CLIENT_KEY = process.env.NEW_ADB2C_CLIENT_KEY;
const NEW_ADB2C_TENANT_ID = process.env.NEW_ADB2C_TENANT_ID;

//////////////////////////////////////////////////////////

export interface IExtendedUserContract extends UserContract {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly groupNames: Set<string>;
}

export interface IApimConfig {
  readonly azurermResourceGroup: string;
  readonly azurermApim: string;
}

export async function getUserGroups(
  apiClient: ApiManagementClient,
  userId: string,
  lconfig: IApimConfig
): Promise<Option<ReadonlyArray<string>>> {
  const existingGroups = await apiClient.userGroup.list(
    lconfig.azurermResourceGroup,
    lconfig.azurermApim,
    userId
  );
  return some(existingGroups.map(g => g.name) as ReadonlyArray<string>);
}

export async function getUserSubscriptions(
  apiClient: ApiManagementClient,
  userId: string,
  lconfig: IApimConfig
): Promise<ApiManagementModels.UserSubscriptionListResponse> {
  console.debug("getUserSubscriptions");
  // TODO: this list is paginated with a next-link
  // by now we get only the first result page
  return apiClient.userSubscription.list(
    lconfig.azurermResourceGroup,
    lconfig.azurermApim,
    userId
  );
}

/**
 * Return the corresponding API management user
 * given the Active Directory B2C user's email.
 */
async function getApimUser(
  apiClient: ApiManagementClient,
  email: string,
  lconfig: IApimConfig
): Promise<Option<IExtendedUserContract>> {
  console.debug("getApimUser");
  const results = await apiClient.user.listByService(
    lconfig.azurermResourceGroup,
    lconfig.azurermApim,
    { filter: "email eq '" + email + "'" }
  );
  console.debug(
    "lookup apimUsers for (%s) (%s)",
    email,
    JSON.stringify(results)
  );
  if (!results || results.length === 0) {
    return none;
  }
  const user = results[0];
  if (!user.id || !user.name || !user.email || !user.email[0]) {
    return none;
  }
  const groupNames = await getUserGroups(apiClient, user.name, lconfig);
  const apimUser = {
    email: user.email,
    id: user.id,
    name: user.name,
    ...user,
    groupNames: isSome(groupNames)
      ? new Set(groupNames.value)
      : new Set<string>()
  };

  // return first matching user
  return some(apimUser);
}

export async function addUserToGroups(
  apiClient: ApiManagementClient,
  userId: string,
  groups: ReadonlyArray<string>,
  lconfig: IApimConfig
): Promise<Either<Error, ReadonlyArray<string>>> {
  console.debug("addUserToGroups");
  const existingGroups = await apiClient.userGroup.list(
    lconfig.azurermResourceGroup,
    lconfig.azurermApim,
    userId
  );
  const existingGroupsNames = new Set(existingGroups.map(g => g.name));
  console.debug(
    "addUserToGroups|existing groups|%s",
    JSON.stringify(Array.from(existingGroupsNames))
  );
  const missingGroups = new Set(
    groups.filter(g => !existingGroupsNames.has(g))
  );
  if (missingGroups.size === 0) {
    console.debug(
      "addUserToGroups|user already belongs to groups|%s",
      JSON.stringify(Array.from(existingGroupsNames))
    );
    return right([]);
  }

  // sequence the promises here as calling this method
  // concurrently seems to cause some issues assigning
  // users to groups
  return right(
    await Array.from(missingGroups).reduce(async (prev, group) => {
      console.debug("addUserToGroups|adding user to group (%s)", group);
      const addedGroups = await prev;
      // If the user already belongs to the unlimited group related
      // to the new group, do not add the user to the limited one
      // (aka: avoids to restrict user rights when adding new subscriptions)
      if (
        existingGroupsNames.has(group.replace(/Limited/, "")) ||
        existingGroupsNames.has(group.replace(/Limited/, "Full"))
      ) {
        console.debug("addUserToGroups|skipping limited group (%s)", group);
        return addedGroups;
      }
      // For some odd reason in the Azure ARM API user.name
      // here is actually the user.id
      await apiClient.groupUser.create(
        lconfig.azurermResourceGroup,
        lconfig.azurermApim,
        group,
        userId
      );
      return [...addedGroups, group];
    }, Promise.resolve([]))
  );
}

async function init(): Promise<ReadonlyArray<void>> {
  const email = (process.argv[2] || "").trim();
  if (email === "") {
    throw new Error("please provide an email");
  }

  const oldCreds = await msRestAzure.loginWithServicePrincipalSecret(
    OLD_ARM_CLIENT_ID,
    OLD_ARM_CLIENT_SECRET,
    OLD_ARM_TENANT_ID
  );

  const oldApiClient = new ApiManagementClient(
    oldCreds,
    OLD_ARM_SUBSCRIPTION_ID
  );

  const oldApimOpt = {
    azurermApim: OLD_APIM_NAME,
    azurermResourceGroup: OLD_APIM_RG
  };

  const maybeOldApimUser = await getApimUser(oldApiClient, email, oldApimOpt);
  if (isNone(maybeOldApimUser)) {
    throw new Error("no user found " + email);
  }
  const oldApimUser = maybeOldApimUser.value;

  console.log(
    "%s (%s)",
    JSON.stringify(oldApimUser),
    Array.from(oldApimUser.groupNames).join(",")
  );

  // login into new active directory b2c
  const newTokenCreds = await msRestAzure.loginWithServicePrincipalSecret(
    NEW_ADB2C_CLIENT_ID,
    NEW_ADB2C_CLIENT_KEY,
    NEW_ADB2C_TENANT_ID,
    { tokenAudience: "graph" }
  );

  const newAdb2cClient = new msGraph.GraphRbacManagementClient(
    newTokenCreds,
    NEW_ADB2C_TENANT_ID,
    { baseUri: "https://graph.windows.net" }
  );

  // const oldAdUser = await adb2cClient.users.get()

  // Create user into new ADB2C tenant and get the user's id
  const newAdUser = await newAdb2cClient.users.create({
    accountEnabled: true,
    creationType: "LocalAccount",
    displayName: [oldApimUser.firstName, oldApimUser.lastName].join(" "),
    givenName: oldApimUser.firstName,
    userPrincipalName: ulid() + "@" + NEW_ADB2C_TENANT_ID,
    mailNickname: oldApimUser.email.split("@")[0],
    passwordProfile: {
      forceChangePasswordNextLogin: true,
      password: randomstring.generate({ length: 32 })
    },
    signInNames: [
      {
        type: "emailAddress",
        value: oldApimUser.email
      }
    ],
    surname: [oldApimUser.firstName, oldApimUser.lastName].join(" "),
    userType: "Member"
  });

  // login into new api management
  const newCreds = await msRestAzure.loginWithServicePrincipalSecret(
    NEW_ARM_CLIENT_ID,
    NEW_ARM_CLIENT_SECRET,
    NEW_ARM_TENANT_ID
  );

  const newApiClient = new ApiManagementClient(
    newCreds,
    NEW_ARM_SUBSCRIPTION_ID
  );

  const newApimOpt = {
    azurermApim: NEW_APIM_NAME,
    azurermResourceGroup: NEW_APIM_RG
  };

  // Create new user into new API management
  const newApimUser = await newApiClient.user.createOrUpdate(
    NEW_APIM_RG,
    NEW_APIM_NAME,
    oldApimUser.name,
    {
      email: oldApimUser.email,
      firstName: oldApimUser.firstName,
      identities: [
        {
          id: newAdUser.objectId,
          provider: "AadB2C"
        }
      ],
      lastName: oldApimUser.lastName || oldApimUser.firstName
    }
  );

  // Copy all previous user's groups
  // groups must exist
  await addUserToGroups(
    newApiClient,
    newApimUser.name,
    Array.from(oldApimUser.groupNames),
    newApimOpt
  );

  // Copy all previous user's subscriptions
  const userSubscriptions = await getUserSubscriptions(
    oldApiClient,
    oldApimUser.name,
    oldApimOpt
  );

  return Promise.all(
    userSubscriptions.map(async subscription => {
      await newApiClient.subscription.createOrUpdate(
        NEW_APIM_RG,
        NEW_APIM_NAME,
        subscription.name,
        {
          displayName: subscription.displayName,
          primaryKey: subscription.primaryKey,
          // TODO: must exists
          scope: subscription.scope,
          secondaryKey: subscription.secondaryKey,
          state: subscription.state,
          ownerId: newApimUser.id
        }
      );
    })
  );
}

init()
  .then(console.log)
  .catch(console.error);
