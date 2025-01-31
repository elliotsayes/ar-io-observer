/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { TurboAuthenticatedClient } from '@ardrive/turbo-sdk/node';
import { ArweaveSigner, createData } from 'arbundles/node';
import Arweave from 'arweave';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import * as winston from 'winston';

import { ObserverReport, ReportInfo, ReportSink } from '../types.js';

const gzip = promisify(zlib.gzip);

async function createReportDataItem(
  signer: ArweaveSigner,
  report: ObserverReport,
) {
  const reportBuffer = Buffer.from(JSON.stringify(report), 'utf-8');
  const gzipReportBuffer = await gzip(reportBuffer);
  const signedDataItem = createData(gzipReportBuffer, signer, {
    tags: [
      { name: 'App-Name', value: 'AR-IO Observer' },
      { name: 'App-Version', value: '0.0.1' },
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Content-Encoding', value: 'gzip' },
      {
        name: 'AR-IO-Component',
        value: 'observer',
      },
      {
        name: 'AR-IO-Epoch-Start-Height',
        value: report.epochStartHeight.toString(),
      },
    ],
  });
  await signedDataItem.sign(signer);

  return signedDataItem;
}

// TODO implement full ReportStore interface
export class TurboReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private arweave: Arweave;
  private readonly turboClient: TurboAuthenticatedClient;
  private readonly walletAddress: string;
  private readonly signer: ArweaveSigner;

  constructor({
    log,
    arweave,
    turboClient,
    walletAddress,
    signer,
  }: {
    log: winston.Logger;
    arweave: Arweave;
    turboClient: TurboAuthenticatedClient;
    walletAddress: string;
    signer: ArweaveSigner;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.turboClient = turboClient;
    this.walletAddress = walletAddress;
    this.signer = signer;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo | undefined> {
    const { report } = reportInfo;
    const log = this.log.child({
      epochStartHeight: report.epochStartHeight,
    });

    // Return existing TX ID if the report was already saved
    try {
      const reportTxId = await this.getReportTxId(report);
      if (reportTxId !== undefined) {
        log.info('Report already saved, skipping upload');
        return {
          ...reportInfo,
          reportTxId,
        };
      }
    } catch (error) {
      log.error('Error checking for existing report', error);
    }

    // Upload the report as a data item using Turbo
    try {
      log.debug('Saving report...');

      // Sign and upload data item
      const signedDataItem = await createReportDataItem(this.signer, report);
      const { id, owner, dataCaches, fastFinalityIndexes } =
        await this.turboClient.uploadSignedDataItem({
          dataItemStreamFactory: () => signedDataItem.getRaw(),
          dataItemSizeFactory: () => signedDataItem.getRaw().length,
        });

      log.info('Report saved using Turbo', {
        id,
        owner,
        dataCaches,
        fastFinalityIndexes,
      });

      // Return the report info with TX ID added
      return {
        ...reportInfo,
        reportTxId: id,
      };
    } catch (error) {
      log.error('Error saving report', error);
    } finally {
      const { winc: newBalance } = await this.turboClient.getBalance();
      log.info(`New Turbo balance: ${newBalance}`, {
        newBalance,
      });
    }

    return undefined;
  }

  async getReportTxId(report: ObserverReport): Promise<string | undefined> {
    const epochStartHeight = report.epochStartHeight;

    // Find the first report TX ID for the given epoch start height
    const queryObject = {
      query: `{
  transactions(
    sort: HEIGHT_ASC,
    first:1,
    owners: [ "${this.walletAddress}" ],
    tags: [
      {
        name: "AR-IO-Epoch-Start-Height",
        values: [ "${epochStartHeight}" ]
      },
      {
        name: "App-Name",
        values: ["AR-IO Observer"]
      }
    ]
  ) 
  {
    edges {
      node {
        id
      }
    }
  }
}`,
    };
    const response = await this.arweave.api.post('/graphql', queryObject);

    // Return the first report TX ID if it exists
    const edges = response?.data?.data?.transactions?.edges;
    if (Array.isArray(edges)) {
      return edges[0]?.node?.id;
    } else {
      return undefined;
    }
  }
}
