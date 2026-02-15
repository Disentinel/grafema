/**
 * ServiceFactory - factory methods for service layer graph nodes
 *
 * Handles: SERVICE_CLASS, SERVICE_INSTANCE, SERVICE_REGISTRATION, SERVICE_USAGE
 */

import { ServiceLayerNode } from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';

export class ServiceFactory {
  static createServiceClass(className: string, file: string, line: number, methods: string[]) {
    return brandNodeInternal(ServiceLayerNode.createClass(className, file, line, methods));
  }

  static createServiceInstance(serviceClass: string, file: string, line: number) {
    return brandNodeInternal(ServiceLayerNode.createInstance(serviceClass, file, line));
  }

  static createServiceRegistration(serviceName: string, objectName: string, file: string, line: number) {
    return brandNodeInternal(ServiceLayerNode.createRegistration(serviceName, objectName, file, line));
  }

  static createServiceUsage(serviceName: string, file: string, line: number) {
    return brandNodeInternal(ServiceLayerNode.createUsage(serviceName, file, line));
  }
}
