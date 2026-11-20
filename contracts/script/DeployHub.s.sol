// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RepoHub} from "../src/RepoHub.sol";
import {IPonsHook, IPonsFeeEscrow} from "../src/interfaces/IPons.sol";

/// OWNER=0x.. VERIFIER=0x.. forge script script/DeployHub.s.sol --rpc-url robinhood --private-key $(cat ../.keys/mainnet-deployer.key) --broadcast
contract DeployHub is Script {
    address constant ESCROW = 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e;
    address constant HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    function run() external returns (RepoHub hub) {
        address owner = vm.envAddress("OWNER");
        address verifier = vm.envAddress("VERIFIER");
        vm.startBroadcast();
        hub = new RepoHub(owner, verifier, IPonsFeeEscrow(ESCROW), IPonsHook(HOOK));
        vm.stopBroadcast();
        console.log("RepoHub", address(hub));
        console.logBytes32(hub.VAULT_CODEHASH());
    }
}
