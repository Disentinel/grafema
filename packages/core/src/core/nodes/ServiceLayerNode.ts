/**
 * ServiceLayerNode - contracts for service layer domain-specific nodes
 *
 * Types: SERVICE_CLASS, SERVICE_INSTANCE, SERVICE_REGISTRATION, SERVICE_USAGE
 *
 * Used by ServiceLayerAnalyzer for detecting Service Layer Pattern.
 *
 * ID formats:
 * - SERVICE_CLASS: <file>:SERVICE_CLASS:<className>:<line>
 * - SERVICE_INSTANCE: <file>:SERVICE_INSTANCE:<className>:<line>
 * - SERVICE_REGISTRATION: <file>:SERVICE_REGISTRATION:<serviceName>:<line>
 * - SERVICE_USAGE: <file>:SERVICE_USAGE:<serviceName>:<line>
 */

import type { BaseNodeRecord } from '@grafema/types';

// --- SERVICE_CLASS ---

export interface ServiceClassNodeRecord extends BaseNodeRecord {
  type: 'SERVICE_CLASS';
  name: string;
  methods: string[];
  file: string;
  line: number;
}

// --- SERVICE_INSTANCE ---

export interface ServiceInstanceNodeRecord extends BaseNodeRecord {
  type: 'SERVICE_INSTANCE';
  serviceClass: string;
  file: string;
  line: number;
}

// --- SERVICE_REGISTRATION ---

export interface ServiceRegistrationNodeRecord extends BaseNodeRecord {
  type: 'SERVICE_REGISTRATION';
  serviceName: string;
  objectName: string;
  file: string;
  line: number;
}

// --- SERVICE_USAGE ---

export interface ServiceUsageNodeRecord extends BaseNodeRecord {
  type: 'SERVICE_USAGE';
  serviceName: string;
  file: string;
  line: number;
}

export class ServiceLayerNode {
  /**
   * Create a SERVICE_CLASS node.
   *
   * @param className - Service class name (e.g., 'UserService')
   * @param file - File path
   * @param line - Line number
   * @param methods - List of method names in the service class
   */
  static createClass(
    className: string,
    file: string,
    line: number,
    methods: string[]
  ): ServiceClassNodeRecord {
    if (!className) throw new Error('ServiceLayerNode.createClass: className is required');
    if (!file) throw new Error('ServiceLayerNode.createClass: file is required');

    return {
      id: `${file}:SERVICE_CLASS:${className}:${line}`,
      type: 'SERVICE_CLASS',
      name: className,
      methods,
      file,
      line,
    };
  }

  /**
   * Create a SERVICE_INSTANCE node.
   *
   * @param serviceClass - Name of the service class being instantiated
   * @param file - File path
   * @param line - Line number
   */
  static createInstance(
    serviceClass: string,
    file: string,
    line: number
  ): ServiceInstanceNodeRecord {
    if (!serviceClass) throw new Error('ServiceLayerNode.createInstance: serviceClass is required');
    if (!file) throw new Error('ServiceLayerNode.createInstance: file is required');

    return {
      id: `${file}:SERVICE_INSTANCE:${serviceClass}:${line}`,
      type: 'SERVICE_INSTANCE',
      name: serviceClass,
      serviceClass,
      file,
      line,
    };
  }

  /**
   * Create a SERVICE_REGISTRATION node.
   *
   * @param serviceName - Registered service name
   * @param objectName - Object used for registration (e.g., 'app')
   * @param file - File path
   * @param line - Line number
   */
  static createRegistration(
    serviceName: string,
    objectName: string,
    file: string,
    line: number
  ): ServiceRegistrationNodeRecord {
    if (!serviceName) throw new Error('ServiceLayerNode.createRegistration: serviceName is required');
    if (!file) throw new Error('ServiceLayerNode.createRegistration: file is required');

    return {
      id: `${file}:SERVICE_REGISTRATION:${serviceName}:${line}`,
      type: 'SERVICE_REGISTRATION',
      name: serviceName,
      serviceName,
      objectName,
      file,
      line,
    };
  }

  /**
   * Create a SERVICE_USAGE node.
   *
   * @param serviceName - Name of the service being used
   * @param file - File path
   * @param line - Line number
   */
  static createUsage(
    serviceName: string,
    file: string,
    line: number
  ): ServiceUsageNodeRecord {
    if (!serviceName) throw new Error('ServiceLayerNode.createUsage: serviceName is required');
    if (!file) throw new Error('ServiceLayerNode.createUsage: file is required');

    return {
      id: `${file}:SERVICE_USAGE:${serviceName}:${line}`,
      type: 'SERVICE_USAGE',
      name: serviceName,
      serviceName,
      file,
      line,
    };
  }

  /**
   * Check if a type belongs to the service layer domain.
   */
  static isServiceLayerType(type: string): boolean {
    return type === 'SERVICE_CLASS' || type === 'SERVICE_INSTANCE' ||
           type === 'SERVICE_REGISTRATION' || type === 'SERVICE_USAGE';
  }

  /**
   * Validate a service layer domain node.
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];

    if (!ServiceLayerNode.isServiceLayerType(node.type)) {
      errors.push(`Expected SERVICE_* type, got ${node.type}`);
    }

    if (!node.id) errors.push('Missing required field: id');

    return errors;
  }
}
