const Joi = require('joi');
const Hoek = require('@hapi/hoek');
const Bourne = require('@hapi/bourne');
const debugCreator = require('debug');

const debug = debugCreator('enjoi');

debugCreator.formatters.f = function (f) {
    return f();
}

const schemaSchema = Joi.alternatives(Joi.object().unknown(true), Joi.string()).required();
const extensionSchema = Joi.alternatives().try(Joi.object().unknown(true), Joi.function())

const optionsSchema = Joi.object({
    subSchemas: Joi.object().unknown(true).default({}),
    extensions: Joi.array().items(extensionSchema).default([]),
    refineType: Joi.func().allow(null),
    refineSchema: Joi.func().allow(null),
    refineDescription: Joi.func().allow(null),
    allowNull: Joi.boolean().default(false),
    forbidArrayNull: Joi.boolean().default(true),
    strictArrayRequired: Joi.boolean().default(false),
    strictRequired: Joi.boolean().default(false),
    strictEnum: Joi.boolean().default(true),
    enableEnum: Joi.boolean().default(true),
    customizedNullValues: Joi.array().items(Joi.any()).default([null]).min(1),
    joiOptions: Joi.object().unknown(true).default({})
});

const overridableOptions = {
    refineType: Joi.func().allow(null),
    refineSchema: Joi.func().allow(null),
    refineDescription: Joi.func().allow(null),
    allowNull: Joi.boolean(),
    forbidArrayNull: Joi.boolean(),
    strictArrayRequired: Joi.boolean(),
    strictRequired: Joi.boolean(),
    noDefaults: Joi.boolean(),
    strictEnum: Joi.boolean(),
    enableEnum: Joi.boolean(),
    customizedNullValues: Joi.array().items(Joi.any()).min(1),
};
const overridableOptionKeys = Object.keys(overridableOptions);
const overrideOptionsSchema = Joi.object(overridableOptions);

function mergeOverridableOptions(target, ...sources) {
    sources.forEach((src) => {
        overridableOptionKeys.forEach((key) => {
            if (typeof src[key] !== 'undefined') {
                target[key] = src[key];
            }
        })
    });
    return target;
}

function isNumber(value) {
    return typeof value === 'number';
}

function isObject(value) {
    return value !== null && typeof value === 'object';
}

function isNotEmptyObject(value) {
    return isObject(value) && Object.keys(value).length > 0;
}

function allowNullIfNeeded(schema, { allowNull = false, forbidArrayNull = true, customizedNullValues = [null] }) {
    if (allowNull) {
        const definition = schema.describe();
        if (definition.flags && definition.flags.only && definition.allow) {
            // Already has enum restriction
            return schema;
        }
        if (!schema.type && (schema.allOf || schema.anyOf || schema.oneOf || schema.not)) {
            return schema;
        }
        if (forbidArrayNull && schema.type === 'array') {
            return schema;
        }
        return schema.allow(...customizedNullValues);
    }
    return schema;
}

function addEnumRestriction(joiSchema, enumList, { allowNull = false, strictEnum = true, enableEnum = true }) {
    if (!enableEnum || !Array.isArray(enumList) || enumList.length === 0) {
        return joiSchema;
    }

    const valids = [].concat(enumList);
    if (allowNull && !strictEnum) {
        if (joiSchema.type === 'string') {
            valids.push('');
        }
        valids.push(null);
    }
    return joiSchema.valid(...valids);
}

function normalizedId(id) {
    return id.replace(/[^a-zA-Z0-9]/g, '_');
}

function getJoiInstance(joiOptions, extensions, joiInstance) {
    if (joiInstance) {
        return joiInstance;
    }
    if (isNotEmptyObject(joiOptions)) {
        joiInstance = Joi.defaults((schema) => schema.options(joiOptions));
    } else {
        joiInstance = Joi;
    }

    return joiInstance.extend(
        {
            type: 'object',
            base: joiInstance.object(),
            coerce: {
                from: 'string',
                method(value) {
                    if (typeof value !== 'string' || (value[0] !== '{' && !/^\s*\{/.test(value))) {
                        return;
                    }
                    try {
                        return { value: Bourne.parse(value) };
                    } catch (ignoreErr) { /* eslint-disable-line no-unused-vars */
                        // Purposefully ignoring error
                    }
                }
            }
        },
        {
            type: 'array',
            base: joiInstance.array(),
            coerce: {
                from: 'string',
                method(value) {
                    if (typeof value !== 'string' || (value[0] !== '[' && !/^\s*\[/.test(value))) {
                        return;
                    }
                    try {
                        return { value: Bourne.parse(value) };
                    } catch (ignoreErr) { /* eslint-disable-line no-unused-vars */
                        // Purposefully ignoring error
                    }
                }
            }
        },
        ...extensions
    );
}

const mapToObj = m => {
    return Array.from(m).reduce((obj, [key, value]) => {
        obj[key] = Joi.isSchema(value) ? value.describe() : value;
        return obj;
    }, {});
};

class SchemaResolver {
    constructor(options, joiInstance) {
        const validatedResult = optionsSchema.validate(options);

        Hoek.assert(!validatedResult.error, validatedResult.error);

        const { subSchemas = {}, extensions = [], joiOptions } = validatedResult.value;

        this.resolveOptions = mergeOverridableOptions({}, validatedResult.value);
        this.subSchemas = subSchemas;
        this.joiOptions = joiOptions;
        this.joiSharedSchemas = new Map();
        this.resolveOptions.noDefaults = this.joiOptions.noDefaults;

        this.joi = getJoiInstance(joiOptions, extensions, joiInstance);

        for (let sharedSchemaId in this.subSchemas) {
            const sharedSchema = this.subSchemas[sharedSchemaId];
            if (typeof sharedSchema === 'object' && !sharedSchema.$id) {
                // shorthand schema type does not need to set $id
                sharedSchema.$id = sharedSchemaId;
            }
            this.joiSharedSchemas.set(sharedSchemaId, this.resolve(sharedSchema, this.resolveOptions));
        }

        const itr = this.joiSharedSchemas.keys();
        this.initialSharedSchemaIds = [];
        for (const id of itr) {
            this.initialSharedSchemaIds.push(id);
        }
    }

    resolveShareSchemas(schema, resolveOptions, sharedProperties = '$defs', baseUri = '') {
        const localShared = schema[sharedProperties]
        if (localShared) {
            for (let sharedSchemaId in localShared) {
                this.joiSharedSchemas.set(
                    `${baseUri}#/${sharedProperties}/${sharedSchemaId}`,
                    this.resolve(localShared[sharedSchemaId], resolveOptions, baseUri)
                );
            }
        }
    }

    convert(schema, options = {}) {
        const validateSchema = schemaSchema.validate(schema);
        const { value: overrideOptions, error: overrideOptionsError } = overrideOptionsSchema.validate(options);

        Hoek.assert(!validateSchema.error, validateSchema.error);
        Hoek.assert(!overrideOptionsError, overrideOptionsError);

        const schemaId = schema.$id || '';
        this.subSchemas[schemaId] = schema;

        const joiSchema = this.resolve(schema, mergeOverridableOptions({}, this.resolveOptions, overrideOptions));

        // Cleanup all shared schema registered other than the initial shared ones
        delete this.subSchemas[schemaId];
        const itr = this.joiSharedSchemas.keys();
        for (const id of itr) {
            if (!this.initialSharedSchemaIds.includes(id)) {
                delete this.subSchemas[id];
                this.joiSharedSchemas.delete(id);
            }
        }
        return joiSchema;
    }

    resolve(schema, resolveOptions = {}, baseUri = (schema.$id || ''), isPropertyRequired = false) {
        if (this.joi.isSchema(schema)) {
            return schema;
        }

        const schemaId = schema.$id;
        let resolvedSchema;

        if (schemaId) {
            baseUri = schemaId;
            if (!this.subSchemas[schemaId]) {
                this.subSchemas[schemaId] = schema;
            }
        }

        this.resolveShareSchemas(schema, resolveOptions, '$defs', baseUri);
        this.resolveShareSchemas(schema, resolveOptions, 'definitions', baseUri);

        if (typeof schema === 'string') {
            // If schema is itself a string, interpret it as a type
            resolvedSchema = this.resolveType({ type: schema }, resolveOptions, baseUri, isPropertyRequired);
        } else if (schema.$ref) {
            if (schema.$ref.trim() === '#') {
                return baseUri ? this.joi.link(`#${normalizedId(baseUri)}`) : this.joi.link('/');
            }

            resolvedSchema = this.resolve(this.resolveReference(schema.$ref, baseUri), resolveOptions, baseUri, isPropertyRequired);
        } else {
            const partialSchemas = [];
            if (schema.type) {
                partialSchemas.push(this.resolveType(schema, resolveOptions, baseUri, isPropertyRequired));
            } else if (schema.properties) {
                // if no type is specified, just properties
                partialSchemas.push(this.object(schema, resolveOptions, baseUri))
            } else if (schema.format) {
                // if no type is specified, just format
                partialSchemas.push(this.string(schema))
            } else if (schema.enum) {
                // If no type is specified, just enum
                partialSchemas.push(
                    addEnumRestriction(this.joi.any().example(schema.enum[0]), schema.enum, resolveOptions)
                );
            } else if (schema.const) {
                // Constant value
                partialSchemas.push(this.getValueJoiType(schema.const).valid(schema.const));
            }
            if (schema.anyOf) {
                partialSchemas.push(this.resolveAnyOf(schema, resolveOptions, baseUri));
            }
            if (schema.allOf) {
                partialSchemas.push(this.resolveAllOf(schema, resolveOptions, baseUri));
            }
            if (schema.oneOf) {
                partialSchemas.push(this.resolveOneOf(schema, resolveOptions, baseUri));
            }
            if (schema.not) {
                partialSchemas.push(this.resolveNot(schema, resolveOptions, baseUri));
            }
            if (partialSchemas.length === 0) {
                //Fall through to whatever.
                console.warn('WARNING: schema missing a \'type\' or \'$ref\' or \'enum\': \n%s', JSON.stringify(schema, null, 2));
                //TODO: Handle better
                partialSchemas.push(this.joi.any());
            }
            resolvedSchema = partialSchemas.length === 1 ? partialSchemas[0] : this.joi.alternatives(partialSchemas).match('all');
        }

        if (resolveOptions.refineSchema) {
            resolvedSchema = resolveOptions.refineSchema(resolvedSchema, schema);
        }

        if (schema.default !== undefined && !resolveOptions.noDefaults) {
            resolvedSchema = resolvedSchema.default(schema.default)
        }

        resolvedSchema = this.copyMetaAnnotations(schema, resolvedSchema);

        if (schemaId && !(this.joiSharedSchemas.get(schemaId))) {
            resolvedSchema = resolvedSchema.id(normalizedId(schemaId));
            this.joiSharedSchemas.set(schemaId, resolvedSchema);
        }

        if (schema.$anchor) {
            this.joiSharedSchemas.set(`${baseUri}#${schema.$anchor}`, resolvedSchema);
        }

        if (isPropertyRequired) {
            resolvedSchema = resolvedSchema.required();
            if (resolveOptions.strictRequired) {
                resolvedSchema = resolvedSchema.invalid(null, '');
            }
        } else {
            resolvedSchema = allowNullIfNeeded(resolvedSchema, resolveOptions);
        }

        return resolvedSchema;
    }

    resolveReference(value, baseUri = '') {
        debug('----- Resolving schema reference: %s with baseUri: %s ----- ', value, baseUri);
        debug('Registered JOI schema for shared: %f', () => {
            return JSON.stringify(mapToObj(this.joiSharedSchemas), null, 2);
        });
        const hashIdx = value.indexOf('#');
        let refSchema;

        if (hashIdx === -1) {
            // Locate through $ref: 'refId'
            // debug('# Resolving reference through id: %s', value);
            refSchema = this.joiSharedSchemas.get(value);
        } else {
            const id = value.substring(0, hashIdx);
            const path = value.substring(hashIdx + 1);

            const canonicalURI = id ? value : `${baseUri}${value}`;

            if (canonicalURI.indexOf('/') === -1) {
                // Locate through $ref: [baseUri]#anchorSchema
                // debug('# Resolving reference through $anchor: %s', canonicalURI);
                refSchema = this.joiSharedSchemas.get(canonicalURI);
            } else if (canonicalURI.indexOf('/properties') === -1) {
                // Locate through $ref: [baseUri]#/$defs/shared
                // debug('# Resolving reference through direct canonicalURI: %s', canonicalURI);
                refSchema = this.joiSharedSchemas.get(canonicalURI);
            } else {
                // Locate through $ref: [baseUri]#/$defs/shared/properties/level1 or [baseUri]#/properties/product
                // Can only get raw schema and build Joi again because it might not completely built yet
                // debug('# Resolving reference through relative path: baseUri - %s; id - %s; path - %s', baseUri, id, path);

                const paths = path.split('/');
                refSchema = this.subSchemas[id || baseUri];

                while (paths.length > 0 && refSchema) {
                    if (paths[0]) {
                        refSchema = refSchema[paths[0]];
                    }
                    paths.splice(0, 1);
                }
            }
        }

        Hoek.assert(refSchema, `Can not find schema reference: ${value} with baseUri: ${baseUri}`);

        return refSchema;
    }

    resolveType(schema, resolveOptions, baseUri, isPropertyRequired = false) {
        let joischema;

        const joitype = (type, options, format) => {
            let joischema;

            if (options.refineType) {
                type = options.refineType(type, format);
            }

            switch (type) {
                case 'array':
                    joischema = this.array(schema, options, baseUri, isPropertyRequired);
                    break;
                case 'boolean':
                    joischema = this.joi.boolean();
                    break;
                case 'integer':
                case 'number':
                    joischema = this.number(schema);
                    break;
                case 'object':
                    joischema = this.object(schema, options, baseUri);
                    break;
                case 'string':
                    joischema = this.string(schema);
                    break;
                case 'null':
                    joischema = this.joi.any().valid(...options.customizedNullValues);
                    break;
                default:
                    joischema = this.joi.types()[type];
            }

            Hoek.assert(joischema, 'Could not resolve type: ' + schema.type + '.');

            return joischema;
        }

        let nullIdx;
        if (Array.isArray(schema.type)) {
            nullIdx = schema.type.findIndex((type) => type === 'null');
            if (nullIdx > -1) {
                schema.type.splice(nullIdx, 1);
            }
            if (schema.type.length === 1) {
                schema.type = schema.type[0];
            } else if (schema.type.length === 0) {
                schema.type = 'null';
            }
        }

        if (Array.isArray(schema.type)) {
            const schemas = [];

            for (let i = 0; i < schema.type.length; i++) {
                schemas.push(joitype(schema.type[i], resolveOptions, schema.format));
            }

            joischema = this.joi.alternatives(schemas);
        } else {
            joischema = joitype(schema.type, resolveOptions, schema.format);
        }
        if (nullIdx > -1) {
            joischema = allowNullIfNeeded(joischema,
                { allowNull: true, customizedNullValues: resolveOptions.customizedNullValues });
        }

        const typeDefinitionMap = {
            title: 'label'
        };
        Object.keys(typeDefinitionMap).forEach(function (key) {
            if (schema[key] !== undefined) {
                joischema = joischema[typeDefinitionMap[key]](schema[key]);
            }
        });

        let desc = schema.description;
        if (resolveOptions.refineDescription) {
            desc = resolveOptions.refineDescription(schema);
        }
        if (desc) {
            joischema = joischema.description(desc);
        }

        let example;
        if (schema.examples && schema.examples.length > 0) {
            example = schema.examples[0];
        }
        if (!example && typeof schema.default !== 'undefined') {
            example = schema.default;
        }
        if (!example && schema.enum && schema.enum.length > 0) {
            example = schema.enum[0];
        }
        if (example) {
            joischema = joischema.type === 'array' && !Array.isArray(example) ? joischema.example([example]) : joischema.example(example);
        }

        return addEnumRestriction(joischema, schema.enum, resolveOptions);
    }

    copyMetaAnnotations(schema, joischema) {
        const metaDataNames = ['title', 'deprecated', 'readOnly', 'writeOnly'];
        const metas = {};
        for (const metaName of metaDataNames) {
            if (typeof schema[metaName] !== 'undefined') {
                metas[metaName] = schema[metaName];
            }
        }

        if (Object.keys(metas).length === 0) {
            return joischema;
        }

        return joischema.meta(metas);
    }

    resolveOneOf(schema, resolveOptions, baseUri) {
        Hoek.assert(Array.isArray(schema.oneOf), 'Expected oneOf to be an array.');

        return this.joi.alternatives(schema.oneOf.map(schema => this.resolve(schema, resolveOptions, baseUri))).match('one');
    }

    resolveAnyOf(schema, resolveOptions, baseUri) {
        Hoek.assert(Array.isArray(schema.anyOf), 'Expected anyOf to be an array.');

        return this.joi.alternatives(schema.anyOf.map(schema => this.resolve(schema, resolveOptions, baseUri))).match('any');
    }

    resolveAllOf(schema, resolveOptions, baseUri) {
        Hoek.assert(Array.isArray(schema.allOf), 'Expected allOf to be an array.');

        return this.joi.alternatives(schema.allOf.map(schema => this.resolve(schema, resolveOptions, baseUri))).match('all');
    }

    resolveNot(schema, resolveOptions, baseUri) {
        Hoek.assert(isObject(schema.not), 'Expected Not to be an object.');

        return this.joi.alternatives().conditional(
          '.',
          {
              not: this.resolve(schema.not, resolveOptions, baseUri),
              then: this.joi.any(),
              otherwise: this.joi.any().forbidden()
          }
        );
    }

    resolveProperties(jsonSchema, resolveOptions, baseUri) {
        const schemas = {};

        if (!isObject(jsonSchema.properties)) {
            return;
        }

        Object.keys(jsonSchema.properties).forEach((key) => {
            const property = jsonSchema.properties[key];
            const isPropertyRequired = Array.isArray(jsonSchema.required) && !!~jsonSchema.required.indexOf(key);

            const joischema = this.resolve(property, resolveOptions, baseUri, isPropertyRequired);

            schemas[key] = joischema;
        });

        return schemas;
    }

    object(schema, resolveOptions, baseUri) {
        let joischema = this.joi.object(this.resolveProperties(schema, resolveOptions, baseUri));

        if (isObject(schema.additionalProperties)) {
            joischema = joischema.pattern(/^/, this.resolve(schema.additionalProperties, resolveOptions, baseUri));
        } else if (typeof this.joiOptions.allowUnknown === 'undefined' || typeof schema.additionalProperties !== 'undefined') {
            joischema = joischema.unknown(schema.additionalProperties !== false);
        }

        isNumber(schema.minProperties) && (joischema = joischema.min(schema.minProperties));
        isNumber(schema.maxProperties) && (joischema = joischema.max(schema.maxProperties));

        return joischema;
    }

    resolveAsArray(value, resolveOptions, baseUri, isPropertyRequired = false) {
        return [].concat(value).map((v) => {
            const vSchema = this.resolve(v, resolveOptions, baseUri);
            if (resolveOptions.strictArrayRequired && isPropertyRequired) {
                return vSchema.invalid(...resolveOptions.customizedNullValues);
            }
            return allowNullIfNeeded(vSchema, resolveOptions)
        });
    }

    array(schema, resolveOptions, baseUri, isPropertyRequired = false) {
        let joischema = this.joi.array();
        let items;

        if (schema.items) {
            items = this.resolveAsArray(schema.items, resolveOptions, baseUri, isPropertyRequired);

            joischema = joischema.items(...items);
        } else if (schema.ordered) {
            items = this.resolveAsArray(schema.ordered, resolveOptions, baseUri, isPropertyRequired);
            joischema = joischema.ordered(...items);
        }

        if (items && schema.additionalItems === false) {
            joischema = joischema.max(items.length);
        }

        if (isPropertyRequired && resolveOptions.strictArrayRequired && !schema.minItems) {
            schema.minItems = 1;
        }
        isNumber(schema.minItems) && (joischema = joischema.min(schema.minItems));
        isNumber(schema.maxItems) && (joischema = joischema.max(schema.maxItems));

        if (schema.uniqueItems) {
            joischema = joischema.unique();
        }
        if (schema.contains) {
            joischema = joischema.has(this.resolve(schema.contains, resolveOptions, baseUri));
        }

        return joischema;
    }

    number(schema) {
        let joischema = this.joi.number();

        if (schema.type === 'integer') {
            joischema = joischema.integer();
        }

        isNumber(schema.minimum) && (joischema = joischema.min(schema.minimum));
        isNumber(schema.maximum) && (joischema = joischema.max(schema.maximum));
        isNumber(schema.exclusiveMinimum) && (joischema = joischema.greater(schema.exclusiveMinimum));
        isNumber(schema.exclusiveMaximum) && (joischema = joischema.less(schema.exclusiveMaximum));
        isNumber(schema.multipleOf) && schema.multipleOf !== 0 && (joischema = joischema.multiple(schema.multipleOf));

        return joischema;
    }

    string(schema) {
        let joischema = this.joi.string();

        const dateRegex = '(\\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])';
        const timeRegex = '([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]|60)(.[0-9]+)?(Z|(\\+|-)([01][0-9]|2[0-3]):([0-5][0-9]))';
        const dateTimeRegex = dateRegex + 'T' + timeRegex;

        switch (schema.format) {
            case 'date':
                return joischema.regex(new RegExp('^' + dateRegex + '$', 'i'), 'JsonSchema date format');
            case 'time':
                return joischema.regex(new RegExp('^' + timeRegex + '$', 'i'), 'JsonSchema time format');
            case 'date-time':
                return joischema.regex(new RegExp('^' + dateTimeRegex + '$', 'i'), 'JsonSchema date-time format');
            case 'binary':
                joischema = this.binary(schema);
                break;
            case 'email':
                return joischema.email();
            case 'hostname':
                return joischema.hostname();
            case 'ipv4':
                return joischema.ip({
                    version: ['ipv4']
                });
            case 'ipv6':
                return joischema.ip({
                    version: ['ipv6']
                });
            case 'uri':
                return joischema.uri();
            case 'byte':
                joischema = joischema.base64();
                break;
            case 'uuid':
                return joischema.guid({ version: ['uuidv4'] });
            case 'guid':
                return joischema.guid();
        }
        return this.regularString(schema, joischema);
    }

    regularString(schema, joischema) {
        schema.pattern && (joischema = joischema.regex(new RegExp(schema.pattern)));

        if ((typeof schema.minLength === 'undefined' || schema.minLength === 0) && !schema.pattern && !schema.format && !schema.enum) {
            joischema = joischema.allow('');
        }

        isNumber(schema.minLength) && (joischema = joischema.min(schema.minLength));
        isNumber(schema.maxLength) && (joischema = joischema.max(schema.maxLength));
        return joischema;
    }

    binary(schema) {
        let joischema = this.joi.binary();
        isNumber(schema.minLength) && (joischema = joischema.min(schema.minLength));
        isNumber(schema.maxLength) && (joischema = joischema.max(schema.maxLength));
        return joischema;
    }

    getValueJoiType(value) {
        let joiType;
        switch (typeof value) {
            case 'string':
                joiType = this.joi.string();
                break;
            case 'number':
                joiType = this.joi.number();
                break;
            case 'boolean':
                joiType = this.joi.boolean();
                break;
            default:
                joiType = this.joi.any();
        }
        return joiType;
    }
}

module.exports = SchemaResolver;
