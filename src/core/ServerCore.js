'use strict';

const { InterfaceMessage } = require("../util/Logger");
const { ConsoleInterface } = require("../util/ConsoleLogger");
const { DiscordInterface } = require("../discord/DiscordInterface");
const { langs } = require("../../data/langs.json");
const meta = require("../../data/meta");
const { infoPlugin } = require("../api/info");
const { downloadsPlugin } = require("../api/downloads");

const { NLU } = require("./Language");
const { Brain } = require("./Brain");

const { EventEmitter } = require("events");
const { DateTime } = require("luxon");
const socketio = require("socket.io");
const { join } = require("path");

require("dotenv").config();

const { fastify } = require("fastify");
const { default: fastifyStatic } = require("fastify-static");

/**
 *  @classdesc Central Processing Core
 *  Coordinates all of the modules to extract meaning from and take action on commands.
 *
 *  @property {EventEmitter}            coreEmitter             - The EventEmitter instance for this Core
 *  @property {number}                  corePort                - The port number for this Core to listen on
 *  @property { {String, String }[] }   registeredInterfaces    - The connected clients registered to the Core
 *  @property {InterfaceMessage}        startupMessage          - The InterfaceMessage generated by the Core startup sequence. Globally accessible.
 *  @property {InterfaceMessage}        modulesStartupMessage   - The InterfaceMessage generated by the Core's Modules startup sequences. Only accessible to Interfaces.
 * */
class Core {

    /**
     * @member {EventEmitter} coreEmitter - The EventEmitter instance for this Core
     */
    coreEmitter;

    /**
     * @member {number} corePort - The port number for this Core to listen on
     */
    corePort = 2010;

    /**
     * @member { [String, String][] } registeredInterfaces - The connected clients registered to the Core
     */
    registeredInterfaces = [];

    /**
     * @member {InterfaceMessage} startupMessage - The InterfaceMessage generated by the Core startup sequence. Globally accessible.
     */
    startupMessage = new InterfaceMessage();


    /**
     * @member {InterfaceMessage} modulesStartupMessage - The InterfaceMessage generated by the Core's Modules startup sequences. Only accessible to Interfaces.
     */
    modulesStartupMessage = new InterfaceMessage();


    /**
     * Creates a new Core. Should only be called once.
     *
     * @constructor
     * @author Curle
     *
     */
    constructor() {
        this.fastify = fastify();
        this.httpServer = { };
        this.brain = { };
        this.nlu = { };
        this.coreEmitter = new EventEmitter();

        // TODO: ASR, STT.

        this.expectedInterfaces = 4;

        /**
         *
         * Register a new Interface.
         *
         * @param  {String} identifier The unique name for the interface. 
         * // TODO: checking for multiple identical identifiers (ie. multiple connected apps?)
         * @param  {String} status The reported initialization status.
         */

        this.coreEmitter.on("registerModule", (name, report) => {
            this.registeredInterfaces.push([name, report]);
            if (this.registeredInterfaces.length == this.expectedInterfaces) {
                let moduleStatus = new InterfaceMessage();
                moduleStatus.source = "Core";
                moduleStatus.destination = "console";
                moduleStatus.title("Module status").beginFormatting();

                for (const iface of this.registeredInterfaces) {
                    moduleStatus.info(iface[0]);
                    if (iface[1] == "Okay")
                        moduleStatus.success(iface[1]);
                    else
                        moduleStatus.warn(iface[1]);
                }

                moduleStatus.endFormatting();

                this.coreEmitter.emit("message", moduleStatus);
            } else if (this.registeredInterfaces.length > this.expectedInterfaces) {
                let moduleStatus = new InterfaceMessage();
                moduleStatus.source = "Core";
                moduleStatus.destination = "console";
                moduleStatus.title(`Module ${name} status`).beginFormatting();
                if(report != "Okay")
                    moduleStatus.warn(report);
                else
                    moduleStatus.success(report);
                moduleStatus.endFormatting();

                this.coreEmitter.emit("message", moduleStatus);
            }
        });

        this.discordInterface = new DiscordInterface(this);
        this.consoleInterface = new ConsoleInterface(this);
    }

    /**
     * Initialise and prepare processing nodes
     * @emits startup
     */

    init() {
        return new Promise(async resolve => {
            let setupMessage = new InterfaceMessage("");

            setupMessage.destination = "any";
            setupMessage.timestamp = Date.now();
            setupMessage.source = "Core";

            setupMessage.title("Initialization").beginFormatting().success(`Running in ${process.env.GWEN_ENV} mode.`);
            setupMessage.success(`Running version ${meta.version}.`);

            if(!Object.keys(langs).includes(process.env.GWEN_LANG)) {
                process.env.GWEN_LANG = 'en-GB';

                setupMessage.warn(`System language not supported. Defaulting to British English. Supported langs are ${Object.keys(langs)}`);
            }

            setupMessage.success(`Current Language is ${process.env.GWEN_LANG}.`);
            setupMessage.success(`Current timezone is ${DateTime.local().zoneName}. This may affect future responses.`)

            setupMessage.endFormatting();


            this.startupMessage = setupMessage;

            this.coreEmitter.emit("startup", setupMessage);

            await this.setupServer();
            // await this.launchListenServer(this.modulesStartupMessage);

            resolve();
        });
    }

    async setupServer() {
        const apiVer = "v4";
        this.fastify.register(fastifyStatic, {
            root: join(__dirname, "..", "web", "dist"),
            prefix: '/'
        });

        this.fastify.get("/", (_request, reply) => reply.sendFile("index.html"));

        this.fastify.register(infoPlugin, { apiVer });
        this.fastify.register(downloadsPlugin, { apiVer });

        this.server = this.fastify.server;

        try {
            await this.listen(this);
        } catch (err) {

            let tempMessage = new InterfaceMessage();
            tempMessage.source = "Core/Server"; tempMessage.destination = "any";
            tempMessage.title(`Core/Server`).beginFormatting().success(`Listen server returned error: ${err.message}`).endFormatting();
            this.coreEmitter.emit("message", tempMessage);
        }
    }

    /**
     * Start listening for requests on the Core port.
     * Will start a SocketIO instance, which will manage deferrring tasks.
     */
    async listen(core) {
        const io = process.env.GWEN_ENV == 'dev' ?
            socketio(this.server, { cors: { origin: `${process.env.GWEN_HOST}:3000` } }) :
            socketio(this.server);

        io.on("connection", (data) => this.newConnection(data, core));

        await this.fastify.listen(this.corePort, '0.0.0.0');

        let dMesg = new InterfaceMessage();
        dMesg.destination = "console";
        dMesg.source = "Core/Server"
        dMesg.title("Core").beginFormatting().success(`Started Core server at ${this.corePort}`).endFormatting();

        this.coreEmitter.emit("message", dMesg);
    }

    /**
     * Handle a new connection to the Core from an Interface.
     * Will start new instances of the central processing services,
     *  so that requests don't conflict.
     *
     * One step closer to parallel processing of requests!
     * @param {socket} socket
     */
    async newConnection(socket, core) {
        socket.on("init", async (data) => {
            let message = new InterfaceMessage();
            message.source = "Core/Server/Socket";
            message.destination = "console";

            message.title("Core/Server/Socket").beginFormatting();

            message.success(`Socket type ${data}, ID: ${socket.id}`);

            if(data == 'hotword')
                socket.on("hotword-detected", (hotwordData) => {
                    message.success(`Hotword ${data.hotword} detected.`);
                    message.endFormatting();

                    this.coreEmitter.emit("message", message);
                    socket.broadcast.emit("record");
                });
            else {
                let stt = "disabled";
                let tts = "disabled";
                
                this.brain = new Brain(socket, langs[process.env.GWEN_LANG].short, core.coreEmitter);
                this.nlu = new NLU(this.brain);
                
                // TODO: SST, TTS
                
                try {
                    await this.nlu.loadModel(join(__dirname, "../../data/model.nlp"));
                } catch (err) {
                    message.warn(`Error raised by NLU: ${err.obj.message}`);
                }
                
                message.endFormatting();
                this.coreEmitter.emit("message", message);

                socket.on("query", async (queryData) => {
                    message = new InterfaceMessage();
                    message.source = "Core/Server/Socket";
                    message.destination = "console";
                    message.title(`Socket ${socket.id}`);
                    message.info(`${queryData.client} emitted ${queryData.value}`);

                    this.coreEmitter.emit("message", message);
                    socket.emit("thinking", true, queryData);
                    await this.nlu.process(queryData.value, queryData.extra);
                });
            }
        });
    }
}

module.exports = {
    Core
}