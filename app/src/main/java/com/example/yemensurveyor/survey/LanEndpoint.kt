package com.example.yemensurveyor.survey

import java.io.Closeable
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class LanEndpoint(
    private val joinPage: ByteArray? = null,
    private val exchange: (String) -> String
) : Closeable {
    private val server = ServerSocket(0)
    private val workers = ThreadPoolExecutor(4, 4, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(12)) { job ->
        Thread(job, "survey-request").apply { isDaemon = true }
    }
    private val acceptWorker = Thread({ listen() }, "survey-listener").apply { isDaemon = true; start() }
    val port: Int get() = server.localPort

    private fun listen() {
        while (!server.isClosed) {
            val socket = runCatching { server.accept() }.getOrNull() ?: break
            try {
                workers.execute { socket.use { runCatching { respond(it) } } }
            } catch (_: RejectedExecutionException) {
                socket.close()
            }
        }
    }

    private fun respond(socket: Socket) {
        socket.soTimeout = 2_000
        val input = socket.getInputStream().buffered()
        val output = socket.getOutputStream().buffered()
        val line = input.httpLine().split(' ')
        val length = input.headers()
        val route = line.getOrNull(1)?.substringBefore('?')
        val type: String
        val status: String
        val payload: ByteArray
        when {
            line.firstOrNull() == "GET" && route == "/join" && joinPage != null -> {
                status = "200 OK"
                type = "text/html; charset=UTF-8"
                payload = joinPage
            }
            line.firstOrNull() == "POST" && route == "/exchange" -> {
                val response = runCatching { exchange(input.readMessage(length)) }.getOrNull()
                status = if (response == null) "403 Forbidden" else "200 OK"
                type = "text/plain"
                payload = response?.toByteArray(Charsets.US_ASCII) ?: ByteArray(0)
            }
            else -> {
                status = "404 Not Found"
                type = "text/plain"
                payload = ByteArray(0)
            }
        }
        output.write(("HTTP/1.1 $status\r\nContent-Type: $type\r\nContent-Length: ${payload.size}\r\n" +
            "Connection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n" +
            "X-Content-Type-Options: nosniff\r\n\r\n").toByteArray())
        output.write(payload)
        output.flush()
    }

    override fun close() {
        server.close()
        workers.shutdown()
        acceptWorker.interrupt()
    }
}
