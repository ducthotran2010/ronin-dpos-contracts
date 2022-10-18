import { network } from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';

import { maintenanceConf, roninInitAddress, roninchainNetworks } from '../../config';
import { verifyAddress } from '../../script/verify-address';
import { Maintenance__factory } from '../../types';

const deploy = async ({ getNamedAccounts, deployments }: HardhatRuntimeEnvironment) => {
  if (!roninchainNetworks.includes(network.name!)) {
    return;
  }

  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const logicContract = await deployments.get('MaintenanceLogic');

  const data = new Maintenance__factory().interface.encodeFunctionData('initialize', [
    roninInitAddress[network.name]!.validatorContract?.address,
    maintenanceConf[network.name]!.minMaintenanceBlockPeriod,
    maintenanceConf[network.name]!.maxMaintenanceBlockPeriod,
    maintenanceConf[network.name]!.minOffset,
    maintenanceConf[network.name]!.maxSchedules,
  ]);

  const deployment = await deploy('MaintenanceProxy', {
    contract: 'TransparentUpgradeableProxyV2',
    from: deployer,
    log: true,
    args: [logicContract.address, roninInitAddress[network.name]!.governanceAdmin?.address, data],
    nonce: roninInitAddress[network.name].maintenanceContract?.nonce,
  });
  verifyAddress(deployment.address, roninInitAddress[network.name].maintenanceContract?.address);
};

deploy.tags = ['MaintenanceProxy'];
deploy.dependencies = ['MaintenanceLogic', 'CalculateAddresses', 'RoninTrustedOrganizationProxy'];

export default deploy;